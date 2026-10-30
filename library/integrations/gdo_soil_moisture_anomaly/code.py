import os
import re
import subprocess
from datetime import date, timedelta
from urllib.parse import urljoin

import numpy as np
import rasterio
import requests
import xarray as xr
from rasterio.transform import from_origin


# Copernicus Global Drought Observatory, Soil Moisture Index Anomaly (ten-daily, 0.05 degree,
# 90N to 60S): standardized anomaly of LISFLOOD/GloFAS 4 modelled root-zone soil moisture
# against a 1995-2023 baseline. Yearly world NetCDF files, the current year's growing.
BASE_URL = (
    "https://drought.emergency.copernicus.eu/data/"
    "Drought_Observatories_datasets/"
    "GDO_Soil_Moisture_Index_Anomaly/"
)
VARIABLE = "smang"
LAYER_ID = "soil_moisture_anomaly"
NODATA = -9999.0
# Standardized anomalies explode where the baseline barely varies (ice, hyper-arid deserts);
# beyond this magnitude the value is a numerical artefact, not a drought signal
MAX_ABS_ANOMALY = 10.0
BACKFILL_MONTHS = 24
SOURCE_VARIANT = "gdo-smi-anomaly-dekadal"
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "DataIntegrator-GDO-Soil-Moisture-Anomaly/1.0"})


def get_text(url):
    response = SESSION.get(url, timeout=60)
    response.raise_for_status()
    return response.text


def version_key(name):
    return tuple(int(part) for part in re.findall(r"\d+", name))


def discover_catalogue():
    """Newest version directory and its yearly files, sorted by coverage."""
    top = get_text(BASE_URL)
    versions = sorted(set(re.findall(r'href="(ver\d+(?:-\d+)+/)"', top)), key=version_key)
    if not versions:
        raise RuntimeError("No version directory found in the GDO soil moisture anomaly catalogue")
    version = versions[-1]
    catalogue_url = urljoin(BASE_URL, version)
    listing = get_text(catalogue_url)
    files = sorted(
        set(re.findall(rf'href="({VARIABLE}_m_gdo_(\d{{8}})_(\d{{8}})_t\.nc)"', listing)),
        key=lambda item: (item[1], item[2]),
    )
    if not files:
        raise RuntimeError(f"No NetCDF files found in {catalogue_url}")
    return version.rstrip("/"), catalogue_url, files


def download(url, destination, refresh=False):
    if os.path.exists(destination) and os.path.getsize(destination) > 0 and not refresh:
        return destination
    partial = destination + ".part"
    if os.path.exists(partial):
        os.remove(partial)
    print(f"Downloading {url}")
    with SESSION.get(url, timeout=(30, 300), stream=True) as response:
        response.raise_for_status()
        with open(partial, "wb") as output:
            for chunk in response.iter_content(1024 * 1024):
                if chunk:
                    output.write(chunk)
    os.replace(partial, destination)
    return destination


def iso_date(value):
    return str(np.datetime_as_string(np.datetime64(value, "D"), unit="D"))


def dekad_end(start):
    """Exclusive end of the ten-day period starting on the 1st, 11th or 21st."""
    if start.day < 21:
        return start + timedelta(days=10)
    return (start.replace(day=1) + timedelta(days=32)).replace(day=1)


def aoi_bbox(definition):
    aoi = definition.get("aoi")
    if isinstance(aoi, dict) and aoi.get("bbox"):
        west, south, east, north = map(float, aoi["bbox"])
    else:
        west, south, east, north = -180.0, -90.0, 180.0, 90.0
    west, east = max(-180.0, west), min(180.0, east)
    south, north = max(-90.0, south), min(90.0, north)
    if west >= east or south >= north:
        raise ValueError(f"Invalid deployment AOI bbox: {[west, south, east, north]}")
    return west, south, east, north


def grid_window(lat, lon, bbox):
    """Row and column slices of the cells whose area intersects the AOI, plus the north-up
    transform and footprint of that window. `lat` must already be descending."""
    west, south, east, north = bbox
    lon_step = float(abs(np.median(np.diff(lon))))
    lat_step = float(abs(np.median(np.diff(lat))))
    x_idx = np.flatnonzero((lon + lon_step / 2 > west) & (lon - lon_step / 2 < east))
    y_idx = np.flatnonzero((lat + lat_step / 2 > south) & (lat - lat_step / 2 < north))
    if x_idx.size == 0 or y_idx.size == 0:
        raise RuntimeError(f"Deployment AOI does not intersect the source grid: {bbox}")
    x0, x1 = int(x_idx[0]), int(x_idx[-1]) + 1
    y0, y1 = int(y_idx[0]), int(y_idx[-1]) + 1
    out_west = float(lon[x0] - lon_step / 2)
    out_north = float(lat[y0] + lat_step / 2)
    transform = from_origin(out_west, out_north, lon_step, lat_step)
    footprint = [out_west, float(lat[y1 - 1] - lat_step / 2), float(lon[x1 - 1] + lon_step / 2), out_north]
    return (slice(y0, y1), slice(x0, x1)), transform, footprint


def clean_values(raw):
    """Float32 window with NaN and implausible magnitudes replaced by NODATA. Returns
    (values, masked_extreme_count)."""
    values = np.asarray(raw, dtype=np.float32)
    finite = np.isfinite(values)
    extreme = finite & (np.abs(values) > MAX_ABS_ANOMALY)
    values = np.where(finite & ~extreme, values, NODATA).astype(np.float32)
    return values, int(extreme.sum())


def write_cog(values, transform, dekad, tmp_dir, out_dir):
    stem = f"{LAYER_ID}_{dekad.replace('-', '')}"
    temporary = os.path.join(tmp_dir, stem + "_source.tif")
    destination = os.path.join(out_dir, stem + ".tif")
    profile = {
        "driver": "GTiff",
        "height": values.shape[0],
        "width": values.shape[1],
        "count": 1,
        "dtype": "float32",
        "crs": "EPSG:4326",
        "transform": transform,
        "nodata": NODATA,
        "tiled": True,
        "blockxsize": 256,
        "blockysize": 256,
        "compress": "DEFLATE",
    }
    with rasterio.open(temporary, "w", **profile) as dataset:
        dataset.write(values, 1)
        dataset.set_band_description(1, "soil moisture anomaly")
        dataset.update_tags(units="dimensionless", source="Copernicus GDO Soil Moisture Index Anomaly", dekad=dekad)
    subprocess.run(
        [
            "gdal_translate", "-q", "-of", "COG", "-a_nodata", str(int(NODATA)),
            "-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=NO", "-co", "BLOCKSIZE=512",
            "-co", "OVERVIEW_RESAMPLING=AVERAGE", temporary, destination,
        ],
        cwd=tmp_dir,
        check=True,
    )
    os.remove(temporary)
    return os.path.basename(destination)


def run(ctx):
    os.makedirs(ctx.work_dir, exist_ok=True)
    os.makedirs(ctx.out_dir, exist_ok=True)

    version, catalogue_url, files = discover_catalogue()
    bbox = aoi_bbox(ctx.definition)
    previous = ctx.previous_state or {}
    source_changed = previous.get("source_variant") != SOURCE_VARIANT
    last_dekad = None if source_changed else previous.get("last_dekad")

    # History depth applies only when there is no cursor: the first run and a rebuild
    backfill = int((ctx.params or {}).get("months_back", BACKFILL_MONTHS))

    # The filename advertises the newest dekad a file holds, so freshness is known without
    # downloading anything
    latest_end = max(item[2] for item in files)
    latest_dekad = f"{latest_end[:4]}-{latest_end[4:6]}-{latest_end[6:8]}"
    state = {
        "last_dekad": last_dekad,
        "source_variant": SOURCE_VARIANT,
        "source_version": version,
        "catalogue_url": catalogue_url,
    }
    incremental = bool(last_dekad)
    if incremental and latest_dekad <= last_dekad:
        print(f"No source data newer than dekad {last_dekad}; source latest is {latest_dekad}")
        return {"state": state}

    if incremental:
        cursor_compact = last_dekad.replace("-", "")
        selected_files = [item for item in files if item[2] > cursor_compact]
    else:
        # Enough yearly files, newest first, to cover the backfill window
        needed_dekads = backfill * 3
        selected_files = []
        covered = 0
        for item in reversed(files):
            selected_files.append(item)
            start = date(int(item[1][:4]), int(item[1][4:6]), int(item[1][6:8]))
            end = date(int(item[2][:4]), int(item[2][4:6]), int(item[2][6:8]))
            covered += ((end.year - start.year) * 12 + end.month - start.month) * 3 + 3
            if covered >= needed_dekads:
                break
        selected_files.reverse()

    # Index the dekads first (cheap: only the time axis is read), trim to the window, then
    # convert one dekad at a time. A global dekad is 86 MB in memory, so they are never all
    # held at once.
    newest_file = files[-1][0]
    wanted = []
    for filename, _, _ in selected_files:
        local_path = os.path.join(ctx.work_dir, filename)
        # The current year's file grows as dekads are published; always refresh it
        download(urljoin(catalogue_url + "/", filename), local_path, refresh=filename == newest_file)
        with xr.open_dataset(local_path, engine="netcdf4", decode_cf=True) as dataset:
            if VARIABLE not in dataset:
                raise RuntimeError(f"Expected variable {VARIABLE} is absent from {filename}")
            for index, time_value in enumerate(dataset["time"].values):
                dekad = iso_date(time_value)
                if incremental and dekad <= last_dekad:
                    continue
                wanted.append((dekad, filename, index))
    wanted.sort(key=lambda item: item[0])
    if not incremental:
        wanted = wanted[-(backfill * 3):]

    rasters = []
    for filename in sorted({item[1] for item in wanted}):
        local_path = os.path.join(ctx.work_dir, filename)
        with xr.open_dataset(local_path, engine="netcdf4", decode_cf=True) as dataset:
            variable = dataset[VARIABLE]
            lat = np.asarray(dataset["lat"].values, dtype=float)
            lon = np.asarray(dataset["lon"].values, dtype=float)
            flip = lat[0] < lat[-1]
            if flip:
                lat = lat[::-1]
            window, transform, footprint = grid_window(lat, lon, bbox)
            for dekad, wanted_file, index in wanted:
                if wanted_file != filename:
                    continue
                grid = variable.isel(time=index)
                if "band" in grid.dims:
                    grid = grid.isel(band=0)
                raw = grid.values
                if flip:
                    raw = raw[::-1, :]
                values, masked = clean_values(raw[window])
                relative_path = write_cog(values, transform, dekad, ctx.tmp_dir, ctx.out_dir)
                valid = values[values != NODATA]
                start = date.fromisoformat(dekad)
                metadata = {
                    "source_product": "GDO Soil Moisture Index Anomaly (ten-daily)",
                    "source_version": version,
                    "source_file": filename,
                    "dekad_start": dekad,
                    "units": "dimensionless",
                    "masked_extreme_cells": masked,
                }
                if valid.size:
                    metadata["minimum"] = float(valid.min())
                    metadata["maximum"] = float(valid.max())
                rasters.append(
                    {
                        "layerId": LAYER_ID,
                        "path": relative_path,
                        "timestamp": f"{dekad}T00:00:00Z",
                        "timestampEnd": f"{dekad_end(start).isoformat()}T00:00:00Z",
                        "footprint": footprint,
                        "crs": "EPSG:4326",
                        "metadata": metadata,
                    }
                )

    rasters.sort(key=lambda item: item["timestamp"])
    state["last_dekad"] = wanted[-1][0] if wanted else last_dekad
    print(f"Prepared {len(rasters)} soil moisture anomaly dekad raster(s); cursor={state['last_dekad']}")
    return {"rasters": rasters, "state": state}
