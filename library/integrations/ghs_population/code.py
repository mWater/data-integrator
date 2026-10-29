import os
import re
import shutil
import subprocess
import time
import zipfile
from datetime import datetime, timezone

import requests
import rasterio

# GHS-POP R2023A population counts on the 3 arc-second WGS84 grid (the grid WorldPop uses), from
# the JRC open-data mirror's 10-degree tiles. Two modes, decided by the runtime AOI:
#   box mode   - the AOI has a bbox: the tiles it touches are mosaicked and clipped to the box
#                into one COG per epoch (a deployment's usual case);
#   world mode - no AOI at all (the platform's "full extent"): every published tile is
#                re-encoded to its own COG and an epoch is one snapshot of ~350 sources.
# Epochs run 1975-2030 in five-year steps; 2020 is the last one built from observed built-up
# surface, later epochs are projections.
RELEASE = "R2023A"
LAST_OBSERVED_EPOCH = 2020
MIRROR = f"https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_POP_GLOBE_{RELEASE}/"
# The 10-degree tile grid of the 4326 products: origin of tile R1_C1, rows top-down, columns
# left-right, only tiles with land published.
GRID_LEFT = -180.00791676306443
GRID_TOP = 89.099583459367
TILE_DEGREES = 10.0
ROWS = 18
COLS = 36
PIXEL_DEGREES = 1.0 / 1200.0
# The source tiles declare no nodata (sea and empty land are both 0); the documented GHS-POP
# nodata is declared on the output so a box reaching past the published tiles is masked.
NODATA = -200.0
ENCODING_VERSION = "float32_deflate_predictor_no_v1"
WORLD_BBOX = [-180.0, -90.0, 180.0, 90.0]
COG_OPTIONS = [
    "-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=NO",
    "-co", "BLOCKSIZE=512", "-co", "BIGTIFF=IF_SAFER",
    "-co", "OVERVIEW_RESAMPLING=NEAREST",
]

RETRIES = 4


def _retrying(label, action):
    """Runs action() up to RETRIES times: the mirror drops connections now and then, and a
    global epoch is hundreds of requests."""
    for attempt in range(1, RETRIES + 1):
        try:
            return action()
        except (requests.RequestException, OSError) as error:
            if attempt == RETRIES:
                raise
            wait = 5 * attempt
            print(f"{label}: {error.__class__.__name__}, retrying in {wait}s ({attempt}/{RETRIES})")
            time.sleep(wait)


def _listing(session, url, pattern):
    """Sorted unique matches of pattern's first group in an Apache directory listing."""
    def fetch():
        response = session.get(url, timeout=90)
        response.raise_for_status()
        return response.text

    return sorted(set(re.findall(pattern, _retrying(url, fetch))))


def _product(epoch):
    return f"GHS_POP_E{epoch}_GLOBE_{RELEASE}_4326_3ss"


def _tiles_url(epoch):
    return f"{MIRROR}{_product(epoch)}/V1-0/tiles/"


def _available_epochs(session):
    epochs = [int(e) for e in _listing(session, MIRROR, rf'href="GHS_POP_E(\d{{4}})_GLOBE_{RELEASE}_4326_3ss/"')]
    if not epochs:
        raise RuntimeError(f"GHSL mirror lists no GHS-POP {RELEASE} 3 arc-second epochs")
    return epochs


def _published_tiles(session, epoch):
    """Names of the epoch's published tile zips (ocean-only tiles are not published)."""
    names = _listing(session, _tiles_url(epoch), r'href="([^"]+\.zip)"')
    if not names:
        raise RuntimeError(f"GHSL mirror lists no tiles for GHS-POP {epoch}")
    return names


def _runtime_scope(ctx):
    """(mode, bbox) from the injected AOI: a box clips, no AOI means the world."""
    aoi = ctx.definition.get("aoi") or {}
    bbox = aoi.get("bbox")
    if bbox is None:
        return "world", None
    if len(bbox) != 4:
        raise ValueError("bbox must be [west, south, east, north]")
    bbox = [float(value) for value in bbox]
    if not (-180 <= bbox[0] < bbox[2] <= 180 and -90 <= bbox[1] < bbox[3] <= 90):
        raise ValueError("Invalid AOI bbox")
    return "box", bbox


def _tile_names_for_box(epoch, bbox, published):
    """Published tiles of the epoch that the box touches."""
    west, south, east, north = bbox
    epsilon = 1e-9
    first_col = int((west - GRID_LEFT) // TILE_DEGREES) + 1
    last_col = int((east - GRID_LEFT - epsilon) // TILE_DEGREES) + 1
    first_row = int((GRID_TOP - north) // TILE_DEGREES) + 1
    last_row = int((GRID_TOP - south - epsilon) // TILE_DEGREES) + 1
    names = []
    for row in range(max(1, first_row), min(ROWS, last_row) + 1):
        for col in range(max(1, first_col), min(COLS, last_col) + 1):
            name = f"{_product(epoch)}_V1_0_R{row}_C{col}.zip"
            if name in published:
                names.append(name)
    return names


def _select_years(available, choice, mode, current_year):
    """Epochs to produce, from the years setting. "auto" takes every published epoch for a
    box (a deployment wants its full series) and only the newest epoch not after the current
    year for the world, since a global epoch is about 30 GB of source."""
    if choice == "all" or (choice == "auto" and mode == "box"):
        return sorted(available)
    at_or_before = [year for year in available if year <= current_year]
    return [max(at_or_before)] if at_or_before else [min(available)]


def _download(session, url, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return
    part = path + ".part"
    print(f"Downloading {url}")

    def fetch():
        with session.get(url, stream=True, timeout=(30, 300)) as response:
            response.raise_for_status()
            with open(part, "wb") as output:
                for chunk in response.iter_content(1024 * 1024):
                    if chunk:
                        output.write(chunk)
        os.replace(part, path)

    _retrying(os.path.basename(path), fetch)


def _run_command(args, cwd):
    print("Running:", " ".join(args))
    subprocess.run(args, cwd=cwd, check=True, stdout=subprocess.DEVNULL)


def _valid_tile(path):
    try:
        with rasterio.open(path) as source:
            return (
                source.crs is not None and source.crs.to_epsg() == 4326
                and source.count == 1 and source.width > 0 and source.height > 0
                and abs(source.transform.a - PIXEL_DEGREES) < 1e-9
                and abs(source.transform.e + PIXEL_DEGREES) < 1e-9
            )
    except Exception:
        return False


def _cached_tile(session, epoch, zip_name, cache_dir):
    """The tile's GeoTIFF, downloaded and extracted once. Each zip holds one .tif plus sidecars."""
    tif_path = os.path.join(cache_dir, zip_name[:-4] + ".tif")
    if os.path.exists(tif_path):
        if _valid_tile(tif_path):
            return tif_path
        os.remove(tif_path)
    zip_path = os.path.join(cache_dir, zip_name)
    _download(session, _tiles_url(epoch) + zip_name, zip_path)
    part = tif_path + ".part"
    try:
        with zipfile.ZipFile(zip_path) as archive:
            members = [n for n in archive.namelist() if n.endswith(".tif")]
            if len(members) != 1:
                raise RuntimeError(f"Expected one GeoTIFF in {zip_name}, found {members}")
            with archive.open(members[0]) as source, open(part, "wb") as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)
        os.replace(part, tif_path)
        if not _valid_tile(tif_path):
            raise RuntimeError(f"Unexpected tile structure in {zip_name}")
    finally:
        if os.path.exists(part):
            os.remove(part)
        os.remove(zip_path)
    return tif_path


def _check_output(path):
    with rasterio.open(path) as result:
        stats = result.statistics(1, approx=True)
        print(f"Produced {os.path.basename(path)}: {result.width}x{result.height}, nodata={result.nodata}, stats={stats}")
        if result.nodata != NODATA:
            raise RuntimeError(f"Output nodata mismatch in {os.path.basename(path)}")
        b = result.bounds
        return [b.left, b.bottom, b.right, b.top]


def _place_in_out(cached, out_dir, name):
    """Expose a cached COG under /out without a second copy when the filesystems allow it."""
    destination = os.path.join(out_dir, name)
    if os.path.exists(destination):
        os.remove(destination)
    try:
        os.link(cached, destination)
    except OSError:
        shutil.copyfile(cached, destination)
    return name


def _box_epoch(session, epoch, bbox, published, cache_root, tmp_dir, out_dir):
    """Box mode: mosaic the tiles the box touches and clip to it into one COG."""
    names = _tile_names_for_box(epoch, bbox, published)
    if not names:
        raise RuntimeError(f"No published GHS-POP {epoch} tiles intersect the AOI")
    print(f"{epoch}: AOI touches {len(names)} published tile(s)")
    cache_dir = os.path.join(cache_root, "tiles", str(epoch))
    os.makedirs(cache_dir, exist_ok=True)
    tile_paths = [_cached_tile(session, epoch, name, cache_dir) for name in names]

    if len(tile_paths) == 1:
        source_path = tile_paths[0]
    else:
        source_path = os.path.join(tmp_dir, f"population_{epoch}.vrt")
        _run_command(["gdalbuildvrt", "-overwrite", source_path] + tile_paths, tmp_dir)

    output_name = f"population_{epoch}.tif"
    output_path = os.path.join(out_dir, output_name)
    if os.path.exists(output_path):
        os.remove(output_path)
    _run_command(
        ["gdalwarp", "-of", "COG", "-te_srs", "EPSG:4326", "-te", *[str(v) for v in bbox], "-tap",
         "-tr", str(PIXEL_DEGREES), str(PIXEL_DEGREES), "-r", "near", "-ot", "Float32",
         "-dstnodata", str(NODATA), *COG_OPTIONS, source_path, output_path],
        tmp_dir,
    )
    footprint = _check_output(output_path)
    return {"path": output_name, "footprint": footprint, "tiles": len(names)}


def _world_epoch(session, epoch, published, cache_root, tmp_dir, out_dir):
    """World mode: one COG per published tile, cached across runs so an interrupted epoch
    resumes. The extracted source is dropped once its COG exists."""
    cog_dir = os.path.join(cache_root, "cog", str(epoch))
    os.makedirs(cog_dir, exist_ok=True)
    sources = []
    for index, zip_name in enumerate(published, 1):
        name = zip_name[:-4].lower().replace(f"_globe_{RELEASE.lower()}_4326_3ss_v1_0", "") + ".tif"
        cached = os.path.join(cog_dir, name)
        if not os.path.exists(cached):
            tile_path = _cached_tile(session, epoch, zip_name, os.path.join(cache_root, "tiles", str(epoch)))
            partial = cached + ".part.tif"
            _run_command(
                ["gdal_translate", "-q", "-of", "COG", "-ot", "Float32", "-a_nodata", str(NODATA),
                 *COG_OPTIONS, tile_path, partial],
                tmp_dir,
            )
            os.replace(partial, cached)
            os.remove(tile_path)
            print(f"{zip_name}: encoded ({index}/{len(published)})")
        footprint = _check_output(cached)
        sources.append({"path": _place_in_out(cached, out_dir, name), "footprint": footprint})
    return sources


def run(ctx):
    mode, bbox = _runtime_scope(ctx)
    years_choice = (ctx.params or {}).get("years", "auto")
    session = requests.Session()
    session.headers.update({"User-Agent": "DataIntegrator-GHSL/1.0"})
    available = _available_epochs(session)
    current_year = datetime.now(timezone.utc).year

    scope_key = {"mode": mode, "bbox": bbox}
    wanted = _select_years(available, years_choice, mode, current_year)
    previous = ctx.previous_state or {}
    same_scope = (
        previous.get("release") == RELEASE
        and previous.get("encodingVersion") == ENCODING_VERSION
        and all(previous.get(key) == value for key, value in scope_key.items())
    )
    completed = {int(year) for year in previous.get("years", [])} if same_scope else set()
    pending = [year for year in wanted if year not in completed]
    print(f"GHS-POP {RELEASE}; mode={mode}; available={available}; wanted={wanted}; pending={pending}")
    state = {
        "release": RELEASE,
        "encodingVersion": ENCODING_VERSION,
        **scope_key,
        "years": sorted(completed),
        "checkedAt": datetime.now(timezone.utc).isoformat(),
    }
    if not pending:
        return {"state": state}

    cache_root = os.path.join(ctx.work_dir, "ghs_pop", RELEASE)
    os.makedirs(cache_root, exist_ok=True)
    os.makedirs(ctx.out_dir, exist_ok=True)
    rasters = []
    produced = set(completed)

    for epoch in pending:
        published = _published_tiles(session, epoch)
        metadata = {
            "source": "GHS-POP",
            "release": RELEASE,
            "mode": mode,
            "epoch": epoch,
            "modeledProjection": epoch > LAST_OBSERVED_EPOCH,
            "units": "people per grid cell",
            "native_crs": "ESRI:54009 (World Mollweide) at 100 m, resampled by the JRC to 3 arc-seconds",
        }
        if mode == "box":
            artifact = _box_epoch(session, epoch, bbox, published, cache_root, ctx.tmp_dir, ctx.out_dir)
            metadata["tiles"] = artifact.pop("tiles")
            raster = {"layerId": "ghs_population", **artifact}
        else:
            sources = _world_epoch(session, epoch, published, cache_root, ctx.tmp_dir, ctx.out_dir)
            metadata["tiles"] = len(sources)
            raster = {"layerId": "ghs_population", "sources": sources, "footprint": WORLD_BBOX}
        raster.update({
            "timestamp": f"{epoch}-01-01T00:00:00Z",
            "timestampEnd": f"{epoch + 1}-01-01T00:00:00Z",
            "crs": "EPSG:4326",
            "metadata": metadata,
        })
        rasters.append(raster)
        produced.add(epoch)

    state["years"] = sorted(produced)
    return {"rasters": rasters, "state": state}
