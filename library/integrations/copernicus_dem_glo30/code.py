import json
import math
import os
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import rasterio
import requests


BASE_URL = "https://copernicus-dem-30m.s3.amazonaws.com"
RELEASE_TIMESTAMP = "2021-01-01T00:00:00Z"
NODATA = -9999.0


def _tile_name(lat, lon):
    ns = "N" if lat >= 0 else "S"
    ew = "E" if lon >= 0 else "W"
    return f"Copernicus_DSM_COG_10_{ns}{abs(lat):02d}_00_{ew}{abs(lon):03d}_00_DEM"


def _tile_url(name):
    return f"{BASE_URL}/{name}/{name}.tif"


def _download_tile(item, cache_dir):
    lat, lon = item
    name = _tile_name(lat, lon)
    path = os.path.join(cache_dir, name + ".tif")

    if os.path.exists(path) and os.path.getsize(path) > 1024:
        try:
            with rasterio.open(path) as src:
                if src.count == 1 and src.crs is not None:
                    return path
        except Exception:
            os.remove(path)

    url = _tile_url(name)
    tmp = path + ".part"
    for attempt in range(4):
        try:
            with requests.get(url, stream=True, timeout=(20, 180)) as response:
                if response.status_code == 404:
                    return None
                response.raise_for_status()
                expected = int(response.headers.get("content-length", "0"))
                written = 0
                with open(tmp, "wb") as output:
                    for chunk in response.iter_content(chunk_size=1024 * 1024):
                        if chunk:
                            output.write(chunk)
                            written += len(chunk)
                if expected and written != expected:
                    raise IOError(f"short download: expected {expected} bytes, received {written}")
            with rasterio.open(tmp) as src:
                if src.count != 1 or src.crs is None:
                    raise ValueError("downloaded object is not a georeferenced, single-band raster")
            os.replace(tmp, path)
            return path
        except Exception as exc:
            if os.path.exists(tmp):
                os.remove(tmp)
            if attempt == 3:
                raise RuntimeError(f"Unable to download {url}: {exc}") from exc
            time.sleep(2 ** attempt)
    return None


def _run_command(args):
    print("Running:", " ".join(args))
    # GDAL's COG driver creates temporary pieces relative to its working directory.
    # Run beside the destination (all command paths are absolute) so those pieces
    # are written to a writable persistent volume rather than the container root.
    command_cwd = os.path.dirname(args[-1]) if os.path.isabs(args[-1]) else None
    completed = subprocess.run(
        args, cwd=command_cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT
    )
    if completed.stdout:
        print(completed.stdout[-12000:])
    if completed.returncode != 0:
        raise RuntimeError(f"Command failed with exit code {completed.returncode}: {' '.join(args)}")


def run(ctx):
    aoi = ctx.definition.get("aoi")
    if not aoi or not aoi.get("bbox"):
        raise ValueError("Copernicus GLO-30 requires a deployment AOI with a bounding box")

    west, south, east, north = [float(v) for v in aoi["bbox"]]
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise ValueError(f"Unsupported AOI bbox {aoi['bbox']}; it must be a non-antimeridian WGS84 bbox")

    # Tiles are named for their integer-degree southwest corner. Avoid including
    # a neighboring tile when the AOI edge lies exactly on an integer degree.
    lon_start = math.floor(west)
    lon_stop = math.ceil(east)
    lat_start = math.floor(south)
    lat_stop = math.ceil(north)
    tiles = [
        (lat, lon)
        for lat in range(lat_start, lat_stop)
        for lon in range(lon_start, lon_stop)
        if -90 <= lat < 90 and -180 <= lon < 180
    ]
    if not tiles:
        raise ValueError("The AOI does not intersect any valid GLO-30 tile")

    cache_dir = os.path.join(ctx.work_dir, "glo30_tiles")
    os.makedirs(cache_dir, exist_ok=True)
    print(f"AOI {west, south, east, north} intersects {len(tiles)} one-degree tile positions")

    paths = []
    missing = []
    workers = min(8, len(tiles))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_download_tile, tile, cache_dir): tile for tile in tiles}
        for future in as_completed(futures):
            tile = futures[future]
            path = future.result()
            if path:
                paths.append(path)
            else:
                missing.append(_tile_name(*tile))

    if not paths:
        raise RuntimeError("The public GLO-30 archive has no source tiles for this AOI")
    paths.sort()
    if missing:
        print(f"Source archive has no object for {len(missing)} tile position(s); these areas remain NoData")
    print(f"Using {len(paths)} source tile(s)")

    vrt_path = os.path.join(ctx.tmp_dir, "glo30_mosaic.vrt")
    output_name = "elevation_glo30.tif"
    output_path = os.path.join(ctx.out_dir, output_name)
    os.makedirs(ctx.out_dir, exist_ok=True)

    # A response file avoids command-line length limits for broad AOIs.
    list_path = os.path.join(ctx.tmp_dir, "glo30_sources.txt")
    with open(list_path, "w", encoding="utf-8") as source_list:
        for path in paths:
            source_list.write(path + "\n")

    _run_command([
        "gdalbuildvrt", "-overwrite", "-resolution", "highest",
        "-vrtnodata", str(NODATA), "-input_file_list", list_path, vrt_path,
    ])
    _run_command([
        "gdalwarp", "-overwrite", "-of", "COG", "-t_srs", "EPSG:4326",
        "-te", str(west), str(south), str(east), str(north),
        "-r", "bilinear", "-dstnodata", str(NODATA),
        "-multi", "-wo", "NUM_THREADS=ALL_CPUS",
        "-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=FLOATING_POINT",
        "-co", "BLOCKSIZE=512", "-co", "BIGTIFF=IF_SAFER",
        vrt_path, output_path,
    ])

    with rasterio.open(output_path) as result:
        if result.count != 1 or result.crs is None:
            raise RuntimeError("Generated elevation COG failed structural validation")
        bounds = [result.bounds.left, result.bounds.bottom, result.bounds.right, result.bounds.top]
        print(json.dumps({
            "output": output_name,
            "width": result.width,
            "height": result.height,
            "bounds": bounds,
            "crs": str(result.crs),
            "nodata": result.nodata,
        }))

    return {
        "rasters": [{
            "layerId": "elevation",
            "path": output_name,
            "timestamp": RELEASE_TIMESTAMP,
            "footprint": bounds,
            "crs": "EPSG:4326",
            "metadata": {
                "source": "Copernicus DEM GLO-30",
                "product": "Copernicus_DSM_COG_10",
                "vertical_reference": "EGM2008",
                "units": "metres",
                "source_tile_count": len(paths),
            },
        }],
        "state": {
            "completed": True,
            "product": "Copernicus DEM GLO-30",
            "release": "2021",
        },
    }
