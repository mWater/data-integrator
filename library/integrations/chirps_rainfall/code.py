import datetime
import gzip
import shutil
import subprocess
from pathlib import Path

import rasterio
import requests

URL = "https://data.chc.ucsb.edu/products/CHIRPS-2.0/africa_monthly/tifs/chirps-v2.0.{year}.{month:02d}.tif.gz"

BACKFILL_MONTHS = 12
MAX_MONTHS_PER_RUN = 12


def prev_month(year, month):
    return (year - 1, 12) if month == 1 else (year, month - 1)


def next_month(year, month):
    return (year + 1, 1) if month == 12 else (year, month + 1)


def month_end(year, month):
    ny, nm = next_month(year, month)
    end = datetime.datetime(ny, nm, 1, tzinfo=datetime.timezone.utc) - datetime.timedelta(seconds=1)
    return end.strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch(year, month, work_dir):
    """Downloads and caches one month's GeoTIFF; returns None if not yet published."""
    tif = Path(work_dir) / f"chirps-{year}-{month:02d}.tif"
    if tif.exists():
        print(f"using cached {tif.name}")
        return tif
    url = URL.format(year=year, month=month)
    print(f"downloading {url}")
    with requests.get(url, stream=True, timeout=600) as r:
        if r.status_code == 404:
            return None
        r.raise_for_status()
        part = tif.with_name(tif.name + ".part")
        with gzip.open(r.raw) as src, open(part, "wb") as f:
            shutil.copyfileobj(src, f)
    part.rename(tif)
    return tif


def run(ctx):
    today = datetime.datetime.now(datetime.timezone.utc)
    last = (ctx.previous_state or {}).get("last_month")
    if last:
        year, month = next_month(int(last[:4]), int(last[5:7]))
    else:
        months_back = int((ctx.params or {}).get("months_back") or BACKFILL_MONTHS)
        year, month = today.year, today.month
        for _ in range(months_back):
            year, month = prev_month(year, month)

    aoi = (ctx.definition.get("aoi") or {}).get("bbox")
    rasters = []
    while len(rasters) < MAX_MONTHS_PER_RUN and (year, month) <= (today.year, today.month):
        src = fetch(year, month, ctx.work_dir)
        if src is None:
            print(f"{year}-{month:02d} not published yet, stopping")
            break
        out_name = f"precip-{year}-{month:02d}.tif"
        with rasterio.open(src) as src_ds:
            nodata = src_ds.nodata if src_ds.nodata is not None else -9999.0
        cmd = ["gdal_translate", "-q", "-a_nodata", str(nodata)]
        if aoi:
            west, south, east, north = aoi
            cmd += ["-projwin", str(west), str(north), str(east), str(south)]
        cmd += ["-of", "COG", "-co", "COMPRESS=DEFLATE", "-co", "RESAMPLING=AVERAGE", str(src), f"{ctx.out_dir}/{out_name}"]
        subprocess.run(cmd, check=True)

        with rasterio.open(f"{ctx.out_dir}/{out_name}") as ds:
            b = ds.bounds
        rasters.append({
            "layerId": "chirps_rainfall",
            "path": out_name,
            "timestamp": f"{year}-{month:02d}-01T00:00:00Z",
            "timestampEnd": month_end(year, month),
            "footprint": [b.left, b.bottom, b.right, b.top],
            "crs": "EPSG:4326",
            "metadata": {"product": "CHIRPS-2.0 africa_monthly", "month": f"{year}-{month:02d}"},
        })
        last = f"{year}-{month:02d}"
        year, month = next_month(year, month)

    result = {"rasters": rasters}
    if last:
        result["state"] = {"last_month": last}
    return result
