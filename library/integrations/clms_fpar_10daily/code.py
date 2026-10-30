import calendar
import csv
import datetime as dt
import io
import json
import math
import os
import re
import subprocess
import time

import numpy as np
import rasterio
from rasterio.windows import Window, bounds as window_bounds, from_bounds
import requests

CATALOGUE = (
    "https://s3.waw3-1.cloudferro.com/swift/v1/CatalogueCSV/"
    "bio-geophysical/vegetation_properties/fapar_global_300m_10daily_v2/"
    "fapar_global_300m_10daily_v2_cog.csv"
)
BUCKET = "eodata"
NODATA = -9999.0


def _request(url):
    for attempt in range(5):
        try:
            response = requests.get(url, timeout=120)
            if response.status_code == 429 or response.status_code >= 500:
                raise requests.HTTPError(f"transient HTTP {response.status_code}", response=response)
            response.raise_for_status()
            return response
        except (requests.ConnectionError, requests.Timeout, requests.HTTPError):
            if attempt == 4:
                raise
            time.sleep(2 ** attempt)


def _credentials(raw):
    credentials = json.loads(raw) if isinstance(raw, str) else dict(raw)
    missing = {"access_key", "secret_key", "endpoint"}.difference(credentials)
    if missing:
        raise ValueError("cdse_s3_credentials is missing: " + ", ".join(sorted(missing)))
    endpoint = credentials["endpoint"].replace("https://", "").replace("http://", "").rstrip("/")
    # GDAL's /vsis3/ driver reads these process-level options. Path-style access is
    # required by the CDSE eodata endpoint.
    os.environ.update({
        "AWS_ACCESS_KEY_ID": credentials["access_key"],
        "AWS_SECRET_ACCESS_KEY": credentials["secret_key"],
        "AWS_S3_ENDPOINT": endpoint,
        "AWS_VIRTUAL_HOSTING": "FALSE",
        "AWS_HTTPS": "YES",
        "AWS_EC2_METADATA_DISABLED": "TRUE",
    })


def _subtract_months(day, months):
    index = day.year * 12 + day.month - 1 - months
    year, month0 = divmod(index, 12)
    month = month0 + 1
    return day.replace(year=year, month=month, day=min(day.day, calendar.monthrange(year, month)[1]))


def _aoi(definition):
    aoi = definition.get("aoi")
    if not aoi or not aoi.get("bbox"):
        raise ValueError("This integration requires the deployment area of interest to provide a bbox")
    west, south, east, north = map(float, aoi["bbox"])
    if west >= east or south >= north:
        raise ValueError(f"Invalid deployment AOI bbox: {aoi['bbox']}")
    clipped = [max(-180.0, west), max(-60.0, south), min(180.0, east), min(80.0, north)]
    if clipped[0] >= clipped[2] or clipped[1] >= clipped[3]:
        raise ValueError("The deployment AOI does not intersect CLMS FPAR coverage (60°S to 80°N)")
    if clipped != [west, south, east, north]:
        print(f"Clipped deployment AOI to FPAR coverage: {clipped}")
    return clipped


def _catalogue(start, end):
    rows = {}
    text = _request(CATALOGUE).text
    for row in csv.DictReader(io.StringIO(text), delimiter=";"):
        match = re.search(r"FAPAR300-RT(\d+)_(\d{8})", row.get("name", ""), re.I)
        if not match:
            continue
        revision = int(match.group(1))
        nominal = dt.datetime.strptime(match.group(2), "%Y%m%d").date()
        if not start <= nominal <= end:
            continue
        row["revision"] = revision
        row["nominal"] = nominal
        old = rows.get(nominal)
        rank = (revision, row.get("modification_date", ""), row.get("id", ""))
        if old is None or rank > (old["revision"], old.get("modification_date", ""), old.get("id", "")):
            rows[nominal] = row
    return rows


def _fpar_key(row):
    folder = row["s3_path"].replace("s3://eodata/", "").rstrip("/")
    base = row["name"]
    if not base.endswith("_cog"):
        raise ValueError(f"Unexpected CLMS COG catalogue name: {base}")
    inner = base[:-4].replace("FAPAR300-", "FAPAR300-FAPAR-", 1) + ".tiff"
    return folder + "/" + inner


def _pixel_window(src, bbox):
    west, south, east, north = bbox
    overlap = [max(west, src.bounds.left), max(south, src.bounds.bottom),
               min(east, src.bounds.right), min(north, src.bounds.top)]
    if overlap[0] >= overlap[2] or overlap[1] >= overlap[3]:
        raise ValueError("Deployment AOI does not intersect this FPAR raster")
    floating = from_bounds(*overlap, transform=src.transform)
    col0 = max(0, math.floor(floating.col_off))
    row0 = max(0, math.floor(floating.row_off))
    col1 = min(src.width, math.ceil(floating.col_off + floating.width))
    row1 = min(src.height, math.ceil(floating.row_off + floating.height))
    return Window(col0, row0, col1 - col0, row1 - row0)


def _period_start(nominal):
    return nominal.replace(day=1 if nominal.day <= 10 else 11 if nominal.day <= 20 else 21)


def _convert(row, bbox, tmp_dir, out_dir):
    nominal = row["nominal"]
    key = _fpar_key(row)
    source = f"/vsis3/{BUCKET}/{key}"
    with rasterio.open(source) as src:
        if src.count != 1:
            raise RuntimeError(f"Expected one FPAR band in {key}, found {src.count}")
        window = _pixel_window(src, bbox)
        raw = src.read(1, window=window, masked=True)
        scale = float(src.scales[0]) if src.scales else 1.0
        offset = float(src.offsets[0]) if src.offsets else 0.0
        if not (0 < scale <= 0.01):
            raise RuntimeError(f"Unexpected FPAR scale {scale} in {key}")
        values = raw.astype("float32") * scale + offset
        data = values.filled(NODATA).astype("float32")
        valid = np.isfinite(data) & (data >= 0.0) & (data <= 1.0)
        data[~valid] = NODATA
        if not np.any(valid):
            raise RuntimeError(f"No valid FPAR values for the deployment AOI in {key}")
        transform = src.window_transform(window)
        footprint = list(window_bounds(window, src.transform))
        crs = src.crs.to_string() if src.crs else "EPSG:4326"
        profile = {
            "driver": "GTiff", "width": int(window.width), "height": int(window.height),
            "count": 1, "dtype": "float32", "crs": src.crs, "transform": transform,
            "nodata": NODATA, "tiled": True, "blockxsize": 512, "blockysize": 512,
            "compress": "deflate", "predictor": 3,
        }
        source_nodata = src.nodata

    temp = os.path.join(tmp_dir, f"fpar_{nominal:%Y%m%d}_temp.tif")
    name = f"fpar_{nominal:%Y%m%d}.tif"
    output = os.path.join(out_dir, name)
    with rasterio.open(temp, "w", **profile) as dst:
        dst.write(data, 1)
        dst.set_band_description(1, "FPAR")
        dst.update_tags(1, units="1", source_scale=scale, source_offset=offset,
                        source_nodata=source_nodata)
    subprocess.run([
        "gdal_translate", "-of", "COG", "-co", "COMPRESS=DEFLATE",
        "-co", "PREDICTOR=FLOATING_POINT", "-co", "BLOCKSIZE=512", temp, output,
    ], check=True, cwd=tmp_dir)
    os.remove(temp)

    valid_values = data[valid]
    quantiles = np.quantile(valid_values, [0.02, 0.5, 0.98])
    stats = {
        "min": float(valid_values.min()), "p02": float(quantiles[0]),
        "median": float(quantiles[1]), "p98": float(quantiles[2]),
        "max": float(valid_values.max()),
    }
    print(f"{nominal} RT{row['revision']}: valid={valid_values.size:,}, "
          f"min={stats['min']:.3f}, median={stats['median']:.3f}, max={stats['max']:.3f}")
    return {
        "layerId": "vegetation_productivity_fpar",
        "path": name,
        "timestamp": nominal.isoformat() + "T00:00:00Z",
        "footprint": footprint,
        "crs": crs,
        "metadata": {
            "source": "Copernicus Land Monitoring Service FPAR300 v2 via CDSE S3",
            "source_object": f"s3://{BUCKET}/{key}",
            "source_product_id": row["id"],
            "nominal_date": nominal.isoformat(),
            "synthesis_period_start": _period_start(nominal).isoformat(),
            "synthesis_period_end": nominal.isoformat(),
            "revision": f"RT{row['revision']}",
            "source_scale": scale, "source_nodata": source_nodata,
            "valid_min": stats["min"], "valid_p02": stats["p02"],
            "valid_median": stats["median"], "valid_p98": stats["p98"],
            "valid_max": stats["max"],
        },
    }


def run(ctx):
    os.makedirs(ctx.out_dir, exist_ok=True)
    _credentials(ctx.secrets["cdse_s3_credentials"])
    bbox = _aoi(ctx.definition)
    today = dt.datetime.now(dt.timezone.utc).date()
    start = _subtract_months(today, 6)
    products = _catalogue(start, today)
    if not products:
        raise RuntimeError(f"CDSE catalogue has no CLMS FPAR products from {start} through {today}")

    previous = dict(ctx.previous_state or {})
    known = previous.get("products", {})
    changed = [(day, row) for day, row in products.items()
               if known.get(day.isoformat()) != row["id"]]
    if not changed:
        previous["last_checked"] = dt.datetime.now(dt.timezone.utc).isoformat()
        print("CDSE catalogue contains no new or revised FPAR composites")
        return {"state": previous}

    rasters = []
    updated = dict(known)
    for day, row in sorted(changed):
        rasters.append(_convert(row, bbox, ctx.tmp_dir, ctx.out_dir))
        updated[day.isoformat()] = row["id"]

    # Retain only the active six-month window; revised products in it are detected by ID.
    updated = {date: product_id for date, product_id in updated.items()
               if dt.date.fromisoformat(date) >= start}
    state = {
        "products": updated,
        "last_success": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    print(f"Prepared {len(rasters)} FPAR raster snapshot(s) from CDSE range reads")
    return {"rasters": rasters, "state": state}
