import calendar
import os
import re
import subprocess
from datetime import date
from urllib.parse import urljoin

import numpy as np
import rasterio
import requests
import xarray as xr
from rasterio.transform import from_origin


# Copernicus Global Drought Observatory: Indicator for Forecasting Unusually Wet and Dry
# Conditions, SPI-3, multi-system (C3S seasonal forecast ensemble). Monthly issues on a
# 1 degree global grid, one yearly NetCDF per version directory.
BASE_URL = (
    "https://drought.emergency.copernicus.eu/data/"
    "Drought_Observatories_datasets/"
    "GDO_Indicator_for_Forecasting_Unusually_Wet_and_Dry_Conditions_SPI3_multi-system/"
)
VARIABLE = "msf03"
LAYER_ID = "spi3_forecast"
NODATA = -9999.0
SOURCE_CLASS_NODATA = 255
BACKFILL_ISSUES = 12
SOURCE_VARIANT = "gdo-spi3-forecast-multi-system"
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "DataIntegrator-GDO-SPI3-Forecast/1.0"})


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
        raise RuntimeError("No version directory found in the GDO SPI-3 forecast catalogue")
    version = versions[-1]
    catalogue_url = urljoin(BASE_URL, version)
    listing = get_text(catalogue_url)
    files = sorted(
        set(re.findall(rf'href="({VARIABLE}_f_gdo_(\d{{8}})_(\d{{8}})_m\.nc)"', listing)),
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
    with SESSION.get(url, timeout=(30, 180), stream=True) as response:
        response.raise_for_status()
        with open(partial, "wb") as output:
            for chunk in response.iter_content(1024 * 1024):
                if chunk:
                    output.write(chunk)
    os.replace(partial, destination)
    return destination


def iso_date(value):
    return str(np.datetime_as_string(np.datetime64(value, "D"), unit="D"))


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


def window_end(issue):
    """Last day of the three-month SPI-3 window that starts in the issue month."""
    year, month = issue.year, issue.month + 2
    if month > 12:
        year, month = year + 1, month - 12
    return date(year, month, calendar.monthrange(year, month)[1])


def subset_grid(class_grid, intensity_grid, lat, lon, bbox):
    """Both bands clipped to the AOI on the native grid, north-up. Returns
    (values[2, rows, cols], transform, footprint)."""
    west, south, east, north = bbox
    lon = np.asarray(lon, dtype=float)
    lat = np.asarray(lat, dtype=float)
    lon_step = float(abs(np.median(np.diff(lon))))
    lat_step = float(abs(np.median(np.diff(lat))))

    # The source stores latitude south-up; flip everything to north-up first
    if lat[0] < lat[-1]:
        lat = lat[::-1]
        class_grid = class_grid[::-1, :]
        intensity_grid = intensity_grid[::-1, :]

    x_idx = np.flatnonzero((lon + lon_step / 2 > west) & (lon - lon_step / 2 < east))
    y_idx = np.flatnonzero((lat + lat_step / 2 > south) & (lat - lat_step / 2 < north))
    if x_idx.size == 0 or y_idx.size == 0:
        raise RuntimeError(f"Deployment AOI does not intersect the SPI-3 forecast grid: {bbox}")
    x0, x1 = int(x_idx[0]), int(x_idx[-1]) + 1
    y0, y1 = int(y_idx[0]), int(y_idx[-1]) + 1

    classes = np.asarray(class_grid[y0:y1, x0:x1], dtype=np.float32)
    classes = np.where(np.isfinite(classes) & (classes != SOURCE_CLASS_NODATA), classes, NODATA)
    intensity = np.asarray(intensity_grid[y0:y1, x0:x1], dtype=np.float32)
    intensity = np.where(np.isfinite(intensity), intensity, NODATA)
    values = np.stack([classes, intensity]).astype(np.float32)

    out_west = float(lon[x0] - lon_step / 2)
    out_north = float(lat[y0] + lat_step / 2)
    transform = from_origin(out_west, out_north, lon_step, lat_step)
    footprint = [out_west, float(lat[y1 - 1] - lat_step / 2), float(lon[x1 - 1] + lon_step / 2), out_north]
    return values, transform, footprint


def write_cog(values, transform, issue, tmp_dir, out_dir):
    stem = f"spi3_forecast_{issue.strftime('%Y%m')}"
    temporary = os.path.join(tmp_dir, stem + "_source.tif")
    destination = os.path.join(out_dir, stem + ".tif")
    profile = {
        "driver": "GTiff",
        "height": values.shape[1],
        "width": values.shape[2],
        "count": 2,
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
        dataset.write(values)
        dataset.set_band_description(1, "warning class")
        dataset.set_band_description(2, "forecast SPI-3")
        dataset.update_tags(
            source="Copernicus GDO SPI-3 forecast indicator, multi-system",
            issue=issue.isoformat(),
        )
    subprocess.run(
        [
            "gdal_translate", "-q", "-of", "COG", "-a_nodata", str(int(NODATA)),
            "-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=NO", "-co", "BLOCKSIZE=512",
            "-co", "RESAMPLING=NEAREST", "-co", "OVERVIEWS=IGNORE_EXISTING",
            temporary, destination,
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
    last_issue = None if source_changed else previous.get("last_issue")

    # History depth applies only when there is no cursor: the first run and a rebuild
    backfill = int((ctx.params or {}).get("issues_back", BACKFILL_ISSUES))

    latest_start = max(item[2] for item in files)
    latest_issue = f"{latest_start[:4]}-{latest_start[4:6]}-{latest_start[6:8]}"
    state = {
        "last_issue": last_issue,
        "source_variant": SOURCE_VARIANT,
        "source_version": version,
        "catalogue_url": catalogue_url,
    }
    if last_issue and latest_issue <= last_issue:
        print(f"No issue newer than {last_issue}; source latest is {latest_issue}")
        return {"state": state}

    # Yearly files: incremental runs need only files ending after the cursor, backfills
    # need enough files to cover the requested number of monthly issues.
    if last_issue:
        selected_files = [item for item in files if item[2] > last_issue.replace("-", "")]
    else:
        needed = backfill
        selected_files = []
        count = 0
        for item in reversed(files):
            selected_files.append(item)
            start, end = item[1], item[2]
            count += (int(end[:4]) - int(start[:4])) * 12 + int(end[4:6]) - int(start[4:6]) + 1
            if count >= needed:
                break
        selected_files.reverse()

    issues = []
    newest_file = files[-1][0]
    for filename, _, _ in selected_files:
        local_path = os.path.join(ctx.work_dir, filename)
        download(urljoin(catalogue_url + "/", filename), local_path, refresh=filename == newest_file)
        with xr.open_dataset(local_path, engine="netcdf4", decode_cf=True) as dataset:
            if VARIABLE not in dataset:
                raise RuntimeError(f"Expected variable {VARIABLE} is absent from {filename}")
            variable = dataset[VARIABLE]
            lat = dataset["lat"].values
            lon = dataset["lon"].values
            for index, time_value in enumerate(dataset["time"].values):
                issue = iso_date(time_value)
                if last_issue and issue <= last_issue:
                    continue
                classes = variable.isel(time=index, band=0).values
                intensity = variable.isel(time=index, band=1).values
                issues.append((issue, filename, classes, intensity, lat, lon))

    issues.sort(key=lambda item: item[0])
    if not last_issue:
        issues = issues[-backfill:]

    rasters = []
    for issue, filename, classes, intensity, lat, lon in issues:
        issue_date = date.fromisoformat(issue)
        values, transform, footprint = subset_grid(classes, intensity, lat, lon, bbox)
        relative_path = write_cog(values, transform, issue_date, ctx.tmp_dir, ctx.out_dir)
        class_values = values[0]
        alarm_cells = int(np.sum((class_values >= 1) & (class_values <= 3)) + np.sum((class_values >= 5) & (class_values <= 7)))
        rasters.append(
            {
                "layerId": LAYER_ID,
                "path": relative_path,
                "timestamp": issue + "T00:00:00Z",
                "timestampEnd": window_end(issue_date).isoformat() + "T00:00:00Z",
                "footprint": footprint,
                "crs": "EPSG:4326",
                "metadata": {
                    "source_product": "GDO Indicator for Forecasting Unusually Wet and Dry Conditions SPI-3, multi-system",
                    "source_version": version,
                    "source_file": filename,
                    "issue": issue,
                    "window": f"{issue[:7]} to {window_end(issue_date).isoformat()[:7]}",
                    "alarm_cells": alarm_cells,
                },
            }
        )

    state["last_issue"] = issues[-1][0] if issues else last_issue
    print(f"Prepared {len(rasters)} SPI-3 forecast issue(s); cursor={state['last_issue']}")
    return {"rasters": rasters, "state": state}
