import json
import math
import os
import re
import shutil
import subprocess
import zipfile
from pathlib import Path

import requests
import rasterio
from pyproj import Transformer


EPOCH = 2020
RELEASE = "R2023A"
VERSION = "V1-0"
PRODUCT = f"GHS_BUILT_S_E{EPOCH}_GLOBE_{RELEASE}_54009_100_V1_0"
TILE_BASE = (
    "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/"
    f"GHS_BUILT_S_GLOBE_{RELEASE}/"
    f"GHS_BUILT_S_E{EPOCH}_GLOBE_{RELEASE}_54009_100/{VERSION}/tiles/"
)
GRID_LEFT = -18041000.0
GRID_TOP = 9000000.0
TILE_SIZE = 1000000.0
NODATA = 65535


def _run(command, env=None):
    print("Running:", " ".join(str(x) for x in command))
    completed = subprocess.run(
        command, env=env, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, text=True,
    )
    if completed.stdout.strip():
        print(completed.stdout.strip())
    if completed.returncode != 0:
        raise RuntimeError(
            f"{command[0]} exited with status {completed.returncode}"
        )


def _download(session, url, destination):
    destination = Path(destination)
    partial = destination.with_suffix(destination.suffix + ".part")
    for attempt in range(1, 4):
        try:
            with session.get(url, stream=True, timeout=(30, 300)) as response:
                response.raise_for_status()
                with open(partial, "wb") as output:
                    for chunk in response.iter_content(1024 * 1024):
                        if chunk:
                            output.write(chunk)
            if partial.stat().st_size == 0:
                raise RuntimeError("download was empty")
            os.replace(partial, destination)
            return
        except Exception:
            partial.unlink(missing_ok=True)
            if attempt == 3:
                raise
            print(f"Download attempt {attempt} failed; retrying {url}")


def _densified_ring(west, south, east, north, steps=180):
    # Corners are exact bbox values; interpolated points stop one step short
    # so rounding never produces a near-duplicate vertex beside a corner.
    points = []
    for i in range(steps):
        t = i / steps
        points.append([west + (east - west) * t, south])
    for i in range(steps):
        t = i / steps
        points.append([east, south + (north - south) * t])
    for i in range(steps):
        t = i / steps
        points.append([east - (east - west) * t, north])
    for i in range(steps):
        t = i / steps
        points.append([west, north - (north - south) * t])
    points.append([west, south])
    return points


def _aoi_geometry(bbox):
    west, south, east, north = bbox
    if not (-180 <= west <= 180 and -180 <= east <= 180 and
            -90 <= south < north <= 90):
        raise ValueError(f"Invalid deployment AOI bbox: {bbox}")
    if west == east:
        raise ValueError("AOI west and east bounds must differ")
    if west < east:
        coordinates = [[_densified_ring(west, south, east, north)]]
    else:
        # A west > east bbox crosses the antimeridian.
        coordinates = [
            [_densified_ring(west, south, 180.0, north)],
            [_densified_ring(-180.0, south, east, north)],
        ]
    return {"type": "MultiPolygon", "coordinates": coordinates}


def _projected_bounds(geometry):
    transformer = Transformer.from_crs("EPSG:4326", "ESRI:54009", always_xy=True)
    xs, ys = [], []
    for polygon in geometry["coordinates"]:
        for lon, lat in polygon[0]:
            x, y = transformer.transform(lon, lat)
            if math.isfinite(x) and math.isfinite(y):
                xs.append(x)
                ys.append(y)
    if not xs:
        raise RuntimeError("The AOI could not be transformed to the GHSL Mollweide grid")
    return min(xs), min(ys), max(xs), max(ys)


def _candidate_names(bounds, available):
    xmin, ymin, xmax, ymax = bounds
    epsilon = 1e-7
    first_col = math.floor((xmin - GRID_LEFT) / TILE_SIZE) + 1
    last_col = math.floor((xmax - GRID_LEFT - epsilon) / TILE_SIZE) + 1
    first_row = math.floor((GRID_TOP - ymax) / TILE_SIZE) + 1
    last_row = math.floor((GRID_TOP - ymin - epsilon) / TILE_SIZE) + 1
    names = []
    for row in range(max(1, first_row), min(18, last_row) + 1):
        for col in range(max(1, first_col), min(37, last_col) + 1):
            name = f"{PRODUCT}_R{row}_C{col}.zip"
            if name in available:
                names.append(name)
    return names


def _cached_tif(session, zip_name, cache_dir):
    tif_name = zip_name[:-4] + ".tif"
    tif_path = cache_dir / tif_name
    if tif_path.exists():
        try:
            with rasterio.open(tif_path) as source:
                if (source.width > 0 and source.height > 0 and
                        source.width <= 10000 and source.height <= 10000 and
                        source.nodata == NODATA and
                        abs(source.transform.a - 100.0) < 1e-8 and
                        abs(source.transform.e + 100.0) < 1e-8):
                    return tif_path
        except Exception:
            pass
        tif_path.unlink(missing_ok=True)

    zip_path = cache_dir / zip_name
    _download(session, TILE_BASE + zip_name, zip_path)
    temporary = tif_path.with_suffix(".tif.part")
    try:
        with zipfile.ZipFile(zip_path) as archive:
            members = [n for n in archive.namelist() if n.endswith(".tif")]
            if len(members) != 1:
                raise RuntimeError(f"Expected one GeoTIFF in {zip_name}, found {members}")
            with archive.open(members[0]) as source, open(temporary, "wb") as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)
        os.replace(temporary, tif_path)
        with rasterio.open(tif_path) as source:
            if (source.width <= 0 or source.height <= 0 or
                    source.width > 10000 or source.height > 10000 or
                    source.nodata != NODATA or
                    abs(source.transform.a - 100.0) >= 1e-8 or
                    abs(source.transform.e + 100.0) >= 1e-8):
                raise RuntimeError(f"Unexpected GHSL tile structure in {zip_name}")
    finally:
        temporary.unlink(missing_ok=True)
        zip_path.unlink(missing_ok=True)
    return tif_path


def run(ctx):
    aoi = ctx.definition.get("aoi")
    if not aoi or not aoi.get("bbox"):
        raise ValueError(
            "This integration requires a deployment area of interest with a bbox; "
            "configure the deployment AOI and run again."
        )
    bbox = [float(value) for value in aoi["bbox"]]
    geometry = _aoi_geometry(bbox)
    projected_bounds = _projected_bounds(geometry)

    session = requests.Session()
    session.headers.update({"User-Agent": "DataIntegrator-GHSL/1.0"})
    listing_response = session.get(TILE_BASE, timeout=(30, 120))
    listing_response.raise_for_status()
    available = set(re.findall(r'href="([^"]+\.zip)"', listing_response.text))
    tile_names = _candidate_names(projected_bounds, available)
    if not tile_names:
        raise RuntimeError("No published GHS-BUILT-S tiles intersect the deployment AOI")
    print(f"AOI intersects {len(tile_names)} published GHSL tile(s)")

    cache_dir = Path(ctx.work_dir) / f"{PRODUCT}_tiles"
    cache_dir.mkdir(parents=True, exist_ok=True)
    tile_paths = [_cached_tif(session, name, cache_dir) for name in tile_names]

    aoi_path = Path(ctx.tmp_dir) / "aoi.geojson"
    with open(aoi_path, "w", encoding="utf-8") as output:
        json.dump({
            "type": "FeatureCollection",
            "features": [{"type": "Feature", "properties": {}, "geometry": geometry}],
        }, output)

    list_path = Path(ctx.tmp_dir) / "tile_list.txt"
    with open(list_path, "w", encoding="utf-8") as output:
        for path in tile_paths:
            output.write(str(path) + "\n")
    vrt_path = Path(ctx.tmp_dir) / "built_surface.vrt"
    _run(["gdalbuildvrt", "-overwrite", "-srcnodata", str(NODATA),
          "-vrtnodata", str(NODATA), "-input_file_list", str(list_path), str(vrt_path)])

    intermediate = Path(ctx.tmp_dir) / "built_surface_clipped.tif"
    final_name = "ghs_built_surface_2020_100m.tif"
    final_path = Path(ctx.out_dir) / final_name
    env = os.environ.copy()
    env["GDAL_CACHEMAX"] = "1024"
    _run([
        "gdalwarp", "-overwrite", "-multi", "-wo", "NUM_THREADS=2",
        "-cutline", str(aoi_path), "-cutline_srs", "EPSG:4326", "-crop_to_cutline",
        "-t_srs", "ESRI:54009", "-tr", "100", "100", "-tap", "-r", "near",
        "-srcnodata", str(NODATA), "-dstnodata", str(NODATA), "-ot", "UInt16",
        "-of", "GTiff", "-co", "TILED=YES", "-co", "COMPRESS=DEFLATE",
        "-co", "PREDICTOR=2", "-co", "BIGTIFF=IF_SAFER",
        str(vrt_path), str(intermediate),
    ], env=env)
    _run([
        "gdal_translate", "-of", "COG", "-co", "COMPRESS=DEFLATE",
        "-co", "PREDICTOR=2", "-co", "BLOCKSIZE=512", "-co", "BIGTIFF=IF_SAFER",
        str(intermediate), str(final_path),
    ], env=env)
    intermediate.unlink(missing_ok=True)

    with rasterio.open(final_path) as result:
        if result.count != 1 or result.width == 0 or result.height == 0:
            raise RuntimeError("The clipped output raster is empty")
        if result.nodata != NODATA:
            raise RuntimeError("The output raster has an unexpected nodata value")
        output_crs = result.crs.to_string()
        output_shape = [result.height, result.width]

    raster = {
        "layerId": "built_up_surface",
        "path": final_name,
        "timestamp": "2020-01-01T00:00:00Z",
        "crs": output_crs,
        "metadata": {
            "dataset": "GHS-BUILT-S",
            "release": RELEASE,
            "epoch": EPOCH,
            "variant": "Total built-up surface (residential + non-residential)",
            "native_resolution_m": 100,
            "native_crs": "ESRI:54009 (World Mollweide)",
            "units": "square metres of built-up surface per cell",
            "tile_count": len(tile_names),
            "output_shape": output_shape,
            "source": "European Commission Joint Research Centre",
            "source_download": TILE_BASE,
            "license": "CC BY 4.0",
        },
    }
    if bbox[0] < bbox[2]:
        raster["footprint"] = bbox
    return {"rasters": [raster]}
