import datetime as dt
import hashlib
import json
import os
import shutil
import subprocess
import time
import urllib.parse
import zipfile

import numpy as np
import requests
import rasterio
from rasterio.transform import from_origin
import xarray as xr


API_ROOT = "https://ewds.climate.copernicus.eu/api"
DATASET = "cems-glofas-historical"
NODATA = -9999.0


def _request(session, method, url, **kwargs):
    """HTTP request with bounded retries for transient EWDS failures."""
    delay = 2.0
    last = None
    for attempt in range(8):
        try:
            response = session.request(method, url, timeout=(30, 180), **kwargs)
            last = response
            if response.status_code not in (408, 425, 429, 500, 502, 503, 504):
                response.raise_for_status()
                return response
        except requests.RequestException:
            if attempt == 7:
                raise
        if attempt == 7:
            break
        retry_after = None if last is None else last.headers.get("Retry-After")
        try:
            wait = float(retry_after) if retry_after else delay
        except ValueError:
            wait = delay
        time.sleep(min(wait, 60))
        delay = min(delay * 2, 60)
    if last is not None:
        try:
            detail = last.json()
        except Exception:
            detail = last.text[:2000]
        raise RuntimeError(f"EWDS request failed ({last.status_code}): {detail}")
    raise RuntimeError("EWDS request failed without a response")


def _link(document, rel):
    for item in document.get("links", []):
        if item.get("rel") == rel:
            return item.get("href")
    return None


def _catalogue_and_constraints(session):
    url = f"{API_ROOT}/catalogue/v1/collections/{DATASET}"
    collection = _request(session, "GET", url).json()
    constraints_url = _link(collection, "constraints")
    if not constraints_url:
        raise RuntimeError("EWDS catalogue did not advertise dataset constraints")
    return collection, _request(session, "GET", constraints_url).json()


def _available_dates(constraints):
    """Expand the catalogue's constraint blocks into valid v4 discharge dates."""
    out = {"consolidated": set(), "intermediate": set()}
    for block in constraints:
        if "version_4_0" not in block.get("system_version", []):
            continue
        if "lisflood" not in block.get("hydrological_model", []):
            continue
        if "time_mean" not in block.get("timespan", []):
            continue
        if "average_river_discharge_in_the_last_24_hours" not in block.get("variable", []):
            continue
        products = set(block.get("product_type", [])) & set(out)
        for product in products:
            for year in block.get("year", []):
                for month in block.get("month", []):
                    for day in block.get("day", []):
                        try:
                            out[product].add(dt.date(int(year), int(month), int(day)))
                        except ValueError:
                            pass
    return out


def _submit_and_download(session, request_body, target):
    process_url = f"{API_ROOT}/retrieve/v1/processes/{DATASET}"
    # Fetching the process first gives a clearer authentication/licence error.
    _request(session, "GET", process_url)
    submitted = _request(
        session,
        "POST",
        f"{process_url}/execution",
        json={"inputs": request_body},
    ).json()
    monitor = _link(submitted, "monitor") or _link(submitted, "self")
    if not monitor:
        raise RuntimeError(f"EWDS submission returned no monitor URL: {submitted}")

    started = time.time()
    delay = 2.0
    while True:
        job = _request(session, "GET", monitor, params={"log": "true", "request": "true"}).json()
        status = job.get("status")
        if status == "successful":
            results_url = _link(job, "results") or f"{monitor}/results"
            results = _request(session, "GET", results_url).json()
            asset = results.get("asset", {}).get("value", {})
            href = asset.get("href")
            if not href:
                raise RuntimeError(f"EWDS successful job returned no downloadable asset: {results}")
            href = urllib.parse.urljoin(results_url, href)
            expected_size = asset.get("file:size")
            part = target + ".part"
            if os.path.exists(part):
                os.remove(part)
            with _request(session, "GET", href, stream=True) as response, open(part, "wb") as f:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        f.write(chunk)
            if expected_size is not None and os.path.getsize(part) != int(expected_size):
                os.remove(part)
                raise RuntimeError("EWDS download size did not match its advertised size")
            os.replace(part, target)
            return target
        if status in ("failed", "rejected", "dismissed", "deleted"):
            detail = job.get("error") or job.get("message") or job
            raise RuntimeError(f"EWDS job {status}: {detail}")
        if status not in ("accepted", "running"):
            raise RuntimeError(f"Unexpected EWDS job status {status!r}: {job}")
        if time.time() - started > 3000:
            raise TimeoutError("EWDS retrieval did not finish within 50 minutes")
        time.sleep(delay)
        delay = min(delay * 1.4, 30)


def _download_group(session, work_dir, bbox, product, year, month, days):
    body = {
        "system_version": ["version_4_0"],
        "hydrological_model": ["lisflood"],
        "product_type": [product],
        "timespan": ["time_mean"],
        "variable": ["average_river_discharge_in_the_last_24_hours"],
        "year": [f"{year:04d}"],
        "month": [f"{month:02d}"],
        "day": [f"{d:02d}" for d in sorted(days)],
        "area": [bbox[3], bbox[0], bbox[1], bbox[2]],
        "data_format": "netcdf",
        "download_format": "zip",
    }
    digest = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()[:20]
    target = os.path.join(work_dir, f"glofas_{digest}.download")
    if os.path.exists(target) and os.path.getsize(target) > 0:
        print(f"Using cached EWDS response for {product} {year}-{month:02d}")
        return target
    print(f"Requesting {product} discharge for {year}-{month:02d}, {len(days)} day(s)")
    return _submit_and_download(session, body, target)


def _netcdf_files(download_path, extraction_dir):
    os.makedirs(extraction_dir, exist_ok=True)
    if zipfile.is_zipfile(download_path):
        paths = []
        with zipfile.ZipFile(download_path) as archive:
            for member in archive.infolist():
                if member.is_dir() or not member.filename.lower().endswith((".nc", ".nc4")):
                    continue
                name = os.path.basename(member.filename)
                path = os.path.join(extraction_dir, name)
                with archive.open(member) as src, open(path + ".part", "wb") as dst:
                    shutil.copyfileobj(src, dst)
                os.replace(path + ".part", path)
                paths.append(path)
        if not paths:
            raise RuntimeError("EWDS archive contained no NetCDF files")
        return paths
    path = os.path.join(extraction_dir, "response.nc")
    shutil.copyfile(download_path, path)
    return [path]


def _coord_name(ds, candidates):
    lower = {name.lower(): name for name in list(ds.coords) + list(ds.dims)}
    for candidate in candidates:
        if candidate in lower:
            return lower[candidate]
    return None


def _date_from_value(value):
    try:
        text = np.datetime_as_string(np.asarray(value).astype("datetime64[s]"), unit="s")
        return dt.date.fromisoformat(text[:10])
    except Exception:
        text = str(value)
        return dt.date.fromisoformat(text[:10])


def _daily_arrays(netcdf_paths, expected_dates):
    """Yield (date, 2-D values, x centers, y centers) from EWDS NetCDF output."""
    expected = set(expected_dates)
    found = set()
    for path in netcdf_paths:
        with xr.open_dataset(path, engine="netcdf4", decode_times=True) as ds:
            xname = _coord_name(ds, ["longitude", "lon", "x"])
            yname = _coord_name(ds, ["latitude", "lat", "y"])
            tname = _coord_name(ds, ["valid_time", "time", "date"])
            if not xname or not yname:
                raise RuntimeError(f"Could not identify longitude/latitude coordinates in {path}")
            candidates = []
            for name, variable in ds.data_vars.items():
                dims = set(variable.dims)
                if xname in dims and yname in dims:
                    candidates.append((name, variable))
            if not candidates:
                raise RuntimeError(f"Could not identify discharge data in {path}")
            preferred = [item for item in candidates if "dis" in item[0].lower() or "river" in item[0].lower()]
            variable = (preferred or candidates)[0][1]
            x = np.asarray(ds[xname].values, dtype="float64")
            y = np.asarray(ds[yname].values, dtype="float64")
            time_dim = tname if tname and tname in variable.dims else None
            if time_dim:
                time_values = np.atleast_1d(ds[tname].values)
                indices = range(len(time_values))
            else:
                time_values = np.array([None])
                indices = range(1)
            for index in indices:
                # The time-mean field is labelled at the end of its 24-hour
                # accumulation window. A request for May 26 therefore has a
                # valid_time of May 27 00:00; catalogue/request dates identify
                # the daily interval represented by the destination snapshot.
                day = (_date_from_value(time_values[index]) - dt.timedelta(days=1)) if time_values[index] is not None else None
                if day is None and len(expected) == 1:
                    day = next(iter(expected))
                if day not in expected:
                    continue
                selected = variable.isel({time_dim: index}) if time_dim else variable
                # EWDS may retain singleton metadata dimensions such as number.
                selected = selected.squeeze(drop=True).transpose(yname, xname)
                values = np.asarray(selected.values, dtype="float32")
                if values.ndim != 2:
                    raise RuntimeError(f"Discharge for {day} is not a 2-D grid: shape={values.shape}")
                found.add(day)
                yield day, values, x.copy(), y.copy()
    missing = expected - found
    if missing:
        raise RuntimeError(f"EWDS response omitted requested dates: {sorted(missing)}")


def _write_cog(out_dir, day, values, x, y):
    if x.ndim != 1 or y.ndim != 1 or len(x) == 0 or len(y) == 0:
        raise RuntimeError("EWDS grid coordinates are not one-dimensional")
    # Normalize 0..360 longitudes when the subset lies in the western hemisphere.
    if np.nanmax(x) > 180:
        normalized = ((x + 180) % 360) - 180
        order = np.argsort(normalized)
        x = normalized[order]
        values = values[:, order]
    if len(x) > 1:
        dx = float(np.median(np.diff(x)))
    else:
        dx = 0.05
    if dx < 0:
        x = x[::-1]
        values = values[:, ::-1]
        dx = -dx
    if len(y) > 1:
        dy_signed = float(np.median(np.diff(y)))
        dy = abs(dy_signed)
    else:
        dy_signed, dy = -0.05, 0.05
    if dy_signed > 0:
        y = y[::-1]
        values = values[::-1, :]
    left = float(x[0] - dx / 2)
    top = float(y[0] + dy / 2)
    clean = np.where(np.isfinite(values), values, NODATA).astype("float32")

    basename = f"river_discharge_{day.isoformat()}.tif"
    tmp = os.path.join(out_dir, f".{basename}.gtiff")
    final = os.path.join(out_dir, basename)
    profile = {
        "driver": "GTiff",
        "height": clean.shape[0],
        "width": clean.shape[1],
        "count": 1,
        "dtype": "float32",
        "crs": "EPSG:4326",
        "transform": from_origin(left, top, dx, dy),
        "nodata": NODATA,
        "tiled": True,
        "compress": "deflate",
        "predictor": 3,
    }
    with rasterio.open(tmp, "w", **profile) as dst:
        dst.write(clean, 1)
        dst.set_band_description(1, "River discharge")
        dst.update_tags(1, units="m3/s")
    subprocess.run(
        [
            "gdal_translate", "-of", "COG", tmp, final,
            "-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=FLOATING_POINT",
            "-co", "BLOCKSIZE=512", "-co", "BIGTIFF=IF_SAFER",
        ],
        check=True,
        cwd=out_dir,
    )
    os.remove(tmp)
    right = left + clean.shape[1] * dx
    bottom = top - clean.shape[0] * dy
    return basename, [left, bottom, right, top]


def run(ctx):
    token = ctx.secrets.get("cds_api_token")
    if not token:
        raise ValueError("Missing required secret: cds_api_token")
    aoi = ctx.definition.get("aoi")
    if not aoi or not aoi.get("bbox"):
        raise ValueError("This integration requires a deployment AOI with a bounding box")
    bbox = [float(v) for v in aoi["bbox"]]
    if bbox[0] >= bbox[2] or bbox[1] >= bbox[3]:
        raise ValueError(f"Unsupported or invalid AOI bounding box: {bbox}")

    os.makedirs(ctx.work_dir, exist_ok=True)
    os.makedirs(ctx.out_dir, exist_ok=True)
    session = requests.Session()
    session.headers.update({
        "PRIVATE-TOKEN": token.strip(),
        "User-Agent": "DataIntegrator-GloFAS/1.0",
    })

    collection, constraints = _catalogue_and_constraints(session)
    available = _available_dates(constraints)
    cutoff = dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=1)
    all_available = sorted((available["consolidated"] | available["intermediate"]) & set(
        d for dates in available.values() for d in dates if d <= cutoff
    ))
    if not all_available:
        raise RuntimeError("EWDS catalogue reports no available GloFAS v4 discharge dates")

    # The rolling window every run keeps current
    backfill_days = int((ctx.params or {}).get("backfill_days", 90))
    target_dates = all_available[-backfill_days:]
    prior = (ctx.previous_state or {}).get("products", {})
    products = dict(prior)

    desired = {}
    for day in target_dates:
        desired[day] = "consolidated" if day in available["consolidated"] else "intermediate"
    # Upgrade every intermediate date retained in state once consolidated is published,
    # even if it has just aged beyond the rolling backfill window.
    for text, old_product in prior.items():
        try:
            day = dt.date.fromisoformat(text)
        except (TypeError, ValueError):
            continue
        if old_product == "intermediate" and day in available["consolidated"]:
            desired[day] = "consolidated"

    pending = {
        day: product for day, product in desired.items()
        if products.get(day.isoformat()) != product
    }
    print(
        f"GloFAS availability through {all_available[-1]}; "
        f"{len(pending)} date(s) to ingest or upgrade"
    )

    grouped = {}
    for day, product in pending.items():
        grouped.setdefault((product, day.year, day.month), []).append(day)

    rasters = []
    for (product, year, month), dates in sorted(grouped.items(), key=lambda item: item[0][1:]):
        download = _download_group(
            session, ctx.work_dir, bbox, product, year, month, [d.day for d in dates]
        )
        digest = hashlib.sha256((download + product).encode()).hexdigest()[:16]
        extract_dir = os.path.join(ctx.tmp_dir, f"extract_{digest}")
        netcdfs = _netcdf_files(download, extract_dir)
        for day, values, x, y in _daily_arrays(netcdfs, dates):
            basename, footprint = _write_cog(ctx.out_dir, day, values, x, y)
            rasters.append({
                "layerId": "river_discharge",
                "path": basename,
                "timestamp": f"{day.isoformat()}T00:00:00Z",
                "timestampEnd": f"{day.isoformat()}T23:59:59Z",
                "footprint": footprint,
                "crs": "EPSG:4326",
                "metadata": {
                    "source_dataset": DATASET,
                    "product_type": product,
                    "system_version": "version_4_0",
                    "hydrological_model": "LISFLOOD",
                    "variable": "average_river_discharge_in_the_last_24_hours",
                },
            })
            products[day.isoformat()] = product

    # Keep enough history to permit delayed intermediate-to-consolidated upgrades.
    keep_after = all_available[-1] - dt.timedelta(days=400)
    products = {
        text: product for text, product in products.items()
        if dt.date.fromisoformat(text) >= keep_after
    }
    state = {
        "products": products,
        "latest_available": all_available[-1].isoformat(),
        "catalogue_updated": collection.get("updated"),
    }
    return {"rasters": rasters, "state": state}
