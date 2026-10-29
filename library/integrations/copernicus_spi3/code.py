import os
import re
import subprocess
from datetime import datetime, timezone
from urllib.parse import urljoin

import numpy as np
import requests
import rasterio
import xarray as xr
from rasterio.transform import from_origin


BASE_URL = (
    "https://drought.emergency.copernicus.eu/data/"
    "Drought_Observatories_datasets/"
    "GDO_ERA5_Standardized_Precipitation_Index_SPI3/"
)
NODATA = -9999.0
BACKFILL_MONTHS = 24
SOURCE_VARIANT = "gdo-era5-spi3-final-dekad"
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "DataIntegrator-Copernicus-SPI3/2.0"})


def get_text(url):
    response = SESSION.get(url, timeout=60)
    response.raise_for_status()
    return response.text


def version_key(name):
    return tuple(int(part) for part in re.findall(r"\d+", name))


def discover_catalogue():
    top = get_text(BASE_URL)
    versions = sorted(
        set(re.findall(r'href="(ver\d+(?:-\d+)+/)"', top)),
        key=version_key,
    )
    if not versions:
        raise RuntimeError("No version directory found in the Copernicus SPI-3 catalogue")

    version = versions[-1]
    catalogue_url = urljoin(BASE_URL, version)
    listing = get_text(catalogue_url)
    files = sorted(
        set(
            re.findall(
                r'href="(spa03_m_gdo_(\d{8})_(\d{8})_t\.nc)"',
                listing,
            )
        ),
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
    # xarray returns numpy datetime64 for this source.
    return np.datetime_as_string(np.datetime64(value, "D"), unit="D")


def aoi_bbox(definition):
    aoi = definition.get("aoi")
    if isinstance(aoi, dict) and aoi.get("bbox"):
        west, south, east, north = map(float, aoi["bbox"])
    else:
        # Explicitly supports deployments without a configured default AOI.
        west, south, east, north = -180.0, -90.0, 180.0, 90.0
    west, east = max(-180.0, west), min(180.0, east)
    south, north = max(-90.0, south), min(90.0, north)
    if west >= east or south >= north:
        raise ValueError(f"Invalid deployment AOI bbox: {[west, south, east, north]}")
    return west, south, east, north


def subset_grid(data_array, bbox):
    west, south, east, north = bbox
    lon = np.asarray(data_array["lon"].values, dtype=float)
    lat = np.asarray(data_array["lat"].values, dtype=float)

    # Include source cells whose area intersects the AOI, preserving the native grid.
    lon_step = float(abs(np.median(np.diff(lon))))
    lat_step = float(abs(np.median(np.diff(lat))))
    x_idx = np.flatnonzero((lon + lon_step / 2 > west) & (lon - lon_step / 2 < east))
    y_idx = np.flatnonzero((lat + lat_step / 2 > south) & (lat - lat_step / 2 < north))
    if x_idx.size == 0 or y_idx.size == 0:
        raise RuntimeError(f"Deployment AOI does not intersect the SPI-3 grid: {bbox}")

    x0, x1 = int(x_idx[0]), int(x_idx[-1]) + 1
    y0, y1 = int(y_idx[0]), int(y_idx[-1]) + 1
    values = np.asarray(data_array.values[y0:y1, x0:x1], dtype=np.float32)
    values = np.where(np.isfinite(values), values, NODATA).astype(np.float32)

    out_west = float(lon[x0] - lon_step / 2)
    out_north = float(lat[y0] + lat_step / 2)
    transform = from_origin(out_west, out_north, lon_step, lat_step)
    footprint = [
        out_west,
        float(lat[y1 - 1] - lat_step / 2),
        float(lon[x1 - 1] + lon_step / 2),
        out_north,
    ]
    return values, transform, footprint


def write_cog(values, transform, selected_dekad, tmp_dir, out_dir):
    month = selected_dekad[:7]
    stem = f"spi3_{month.replace('-', '')}"
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
        "predictor": 3,
    }
    with rasterio.open(temporary, "w", **profile) as dataset:
        dataset.write(values, 1)
        dataset.set_band_description(1, "SPI-3")
        dataset.update_tags(
            units="dimensionless",
            source="Copernicus Global Drought Observatory ERA5 SPI-3 final dekad",
            selected_dekad=selected_dekad,
        )

    command = [
        "gdal_translate",
        "-q",
        "-of",
        "COG",
        "-a_nodata",
        str(int(NODATA)),
        "-co",
        "COMPRESS=DEFLATE",
        "-co",
        "PREDICTOR=FLOATING_POINT",
        "-co",
        "BLOCKSIZE=512",
        temporary,
        destination,
    ]
    subprocess.run(command, cwd=tmp_dir, check=True)
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
    if source_changed and previous:
        print("Source variant changed to ERA5; starting a fresh backfill")

    # History depth applies only when there is no cursor: the first run and a rebuild
    backfill = int((ctx.params or {}).get("months_back", BACKFILL_MONTHS))

    latest_end = max(item[2] for item in files)
    latest_end_date = f"{latest_end[:4]}-{latest_end[4:6]}-{latest_end[6:8]}"
    if last_dekad and latest_end_date <= last_dekad:
        print(f"No source data newer than selected dekad {last_dekad}; source latest is {latest_end_date}")
        return {
            "state": {
                "last_dekad": last_dekad,
                "source_variant": SOURCE_VARIANT,
                "source_version": version,
                "catalogue_url": catalogue_url,
            }
        }

    # Initial/migration runs need enough annual files to cover 24 final dekads.
    # Incremental runs only need files whose advertised end date is newer than the cursor.
    selected_files = []
    if last_dekad:
        cursor_compact = last_dekad.replace("-", "")
        selected_files = [item for item in files if item[2] > cursor_compact]
    else:
        needed = backfill
        approximate_count = 0
        for item in reversed(files):
            selected_files.append(item)
            start = datetime.strptime(item[1], "%Y%m%d")
            end = datetime.strptime(item[2], "%Y%m%d")
            approximate_count += (end.year - start.year) * 12 + end.month - start.month + 1
            if approximate_count >= needed:
                break
        selected_files.reverse()

    observations = []
    newest_file = files[-1][0]
    for filename, _, _ in selected_files:
        local_path = os.path.join(ctx.work_dir, filename)
        # The active annual file is replaced as new months arrive; always refresh it.
        download(urljoin(catalogue_url + "/", filename), local_path, refresh=filename == newest_file)
        with xr.open_dataset(local_path, engine="netcdf4", decode_cf=True) as dataset:
            if "spa03" not in dataset:
                raise RuntimeError(f"Expected variable spa03 is absent from {filename}")
            variable = dataset["spa03"]
            for index, time_value in enumerate(dataset["time"].values):
                selected_dekad = iso_date(time_value)
                if not selected_dekad.endswith("-21"):
                    continue
                if last_dekad and selected_dekad <= last_dekad:
                    continue
                observations.append(
                    (selected_dekad, filename, variable.isel(time=index, band=0).load())
                )

    observations.sort(key=lambda item: item[0])
    if not last_dekad:
        keep = backfill
        observations = observations[-keep:]

    rasters = []
    for selected_dekad, filename, grid in observations:
        values, transform, footprint = subset_grid(grid, bbox)
        relative_path = write_cog(
            values, transform, selected_dekad, ctx.tmp_dir, ctx.out_dir
        )
        valid = values[values != NODATA]
        metadata = {
            "source_product": "GDO ERA5 Standardized Precipitation Index SPI-3",
            "source_version": version,
            "source_file": filename,
            "selected_dekad": selected_dekad,
            "monthly_selection": "final dekad starting on day 21",
            "units": "dimensionless",
        }
        if valid.size:
            metadata["minimum"] = float(valid.min())
            metadata["maximum"] = float(valid.max())
        month_timestamp = selected_dekad[:7] + "-01T00:00:00Z"
        rasters.append(
            {
                "layerId": "spi3",
                "path": relative_path,
                "timestamp": month_timestamp,
                "footprint": footprint,
                "crs": "EPSG:4326",
                "metadata": metadata,
            }
        )

    new_last = observations[-1][0] if observations else last_dekad
    print(f"Prepared {len(rasters)} ERA5 SPI-3 monthly raster(s); cursor={new_last}")
    return {
        "rasters": rasters,
        "state": {
            "last_dekad": new_last,
            "source_variant": SOURCE_VARIANT,
            "source_version": version,
            "catalogue_url": catalogue_url,
        },
    }
