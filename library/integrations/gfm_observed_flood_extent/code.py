import datetime as dt
import math
import os
import subprocess
import time
import xml.etree.ElementTree as ET
from collections import OrderedDict

import numpy as np
import rasterio
from rasterio.vrt import WarpedVRT
from rasterio.enums import Resampling
from rasterio.windows import Window
from rasterio.warp import transform_bounds
import requests


STAC_SEARCH = "https://stac.eodc.eu/api/v1/search"
COLLECTION = "GFM"
ASSET = "ensemble_flood_extent"
LAYER_ID = "observed_flood_extent"
NODATA = 255
PIXEL_SIZE = 20
INITIAL_DAYS = 365
MAX_DAYS_PER_RUN = 7
# Format of the stored snapshots. State from another format is discarded and the
# configured history loaded again, replacing every snapshot; raise it whenever the
# COGs this code writes change in a way existing snapshots must follow.
STATE_VERSION = 3
TARGET_CRS = "EPSG:3857"
# Rows merged at once per frame: a multiple of the 512-row output block.
STRIP_ROWS = 2048
# GDAL block cache in MB. GDAL's default is a share of the host's RAM, not of
# the job's memory limit.
GDAL_CACHE_MB = "512"


def _iso(value):
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _aoi_bbox(definition):
    aoi = definition.get("aoi")
    if not isinstance(aoi, dict) or not aoi.get("bbox"):
        raise RuntimeError(
            "This integration requires the deployment AOI to resolve to an aoi.bbox at run time. "
            "Configure a deployment area of interest before running it."
        )
    bbox = [float(v) for v in aoi["bbox"]]
    if len(bbox) != 4 or not (bbox[0] < bbox[2] and bbox[1] < bbox[3]):
        raise ValueError(f"Invalid deployment AOI bbox: {bbox}")
    return bbox


def _search_days(bbox, start_day, end_day):
    start = dt.datetime.combine(start_day, dt.time.min, tzinfo=dt.timezone.utc)
    end = dt.datetime.combine(end_day, dt.time.max, tzinfo=dt.timezone.utc)
    payload = {
        "collections": [COLLECTION],
        "bbox": bbox,
        "datetime": f"{_iso(start)}/{_iso(end)}",
        "limit": 500,
        "sortby": [{"field": "datetime", "direction": "asc"}],
    }
    url = STAC_SEARCH
    groups = OrderedDict()
    seen = set()
    session = requests.Session()

    for page in range(1, 201):
        response = session.post(url, json=payload, timeout=(20, 120))
        response.raise_for_status()
        body = response.json()
        features = body.get("features")
        if not isinstance(features, list):
            raise RuntimeError("GFM STAC search returned no feature list")

        for feature in features:
            timestamp = feature.get("properties", {}).get("datetime")
            href = feature.get("assets", {}).get(ASSET, {}).get("href")
            if not timestamp or not href:
                print(f"Skipping STAC item without datetime/{ASSET}: {feature.get('id', '<unknown>')}")
                continue
            day = dt.datetime.fromisoformat(timestamp.replace("Z", "+00:00")).date()
            key = (feature.get("id"), href)
            if key in seen:
                continue
            seen.add(key)
            groups.setdefault(day, []).append(
                {"id": feature.get("id", "unknown"), "href": href, "datetime": timestamp}
            )

        next_link = next((link for link in body.get("links", []) if link.get("rel") == "next"), None)
        if not next_link or not features:
            break
        url = next_link.get("href", STAC_SEARCH)
        payload = next_link.get("body", payload)
    else:
        raise RuntimeError("GFM STAC pagination exceeded 200 pages")

    return groups


def _intersection(a, b):
    result = (max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3]))
    return result if result[0] < result[2] and result[1] < result[3] else None


def _source_window(bounds, left, top, width, height):
    col0 = max(0, int(math.floor((bounds[0] - left) / PIXEL_SIZE)))
    col1 = min(width, int(math.ceil((bounds[2] - left) / PIXEL_SIZE)))
    row0 = max(0, int(math.floor((top - bounds[3]) / PIXEL_SIZE)))
    row1 = min(height, int(math.ceil((top - bounds[1]) / PIXEL_SIZE)))
    if col0 >= col1 or row0 >= row1:
        return None
    return Window(col0, row0, col1 - col0, row1 - row0)


def _strips(window):
    """Splits a frame's window into strips of whole 512-row output blocks. A frame
    spans hundreds of millions of pixels; merging it in one piece, its arrays and
    temporaries together exceed the job memory limit."""
    row = int(window.row_off)
    end = row + int(window.height)
    while row < end:
        strip_end = min(end, (row // STRIP_ROWS + 1) * STRIP_ROWS)
        yield Window(window.col_off, row, window.width, strip_end - row)
        row = strip_end


def _count_values(dataset, out_width=None, out_height=None, level_label="full resolution"):
    """Count values at full resolution or at one exact internal-overview shape."""
    out_width = out_width or dataset.width
    out_height = out_height or dataset.height
    counts = {"0": 0, "1": 0, "255": 0}
    tile_size = 512
    for row in range(0, out_height, tile_size):
        tile_height = min(tile_size, out_height - row)
        for col in range(0, out_width, tile_size):
            tile_width = min(tile_size, out_width - col)
            # Proportional floating-point windows address the exact overview grid,
            # including GDAL's non-power-of-two reported factor for odd dimensions.
            window = Window(
                col * dataset.width / out_width,
                row * dataset.height / out_height,
                tile_width * dataset.width / out_width,
                tile_height * dataset.height / out_height,
            )
            data = dataset.read(
                1,
                window=window,
                out_shape=(tile_height, tile_width),
                resampling=Resampling.nearest,
            )
            unexpected = np.unique(data[~np.isin(data, (0, 1, NODATA))])
            if unexpected.size:
                raise RuntimeError(f"Unexpected values at {level_label}: {unexpected.tolist()}")
            counts["0"] += int(np.count_nonzero(data == 0))
            counts["1"] += int(np.count_nonzero(data == 1))
            counts["255"] += int(np.count_nonzero(data == NODATA))
    return counts


def _build_max_pooled_overviews(intermediate, base, profile, ctx):
    """Create every explicit 2x level atomically, including all-nodata levels."""
    overview_paths = []
    expected_counts = {}
    parent_path = intermediate
    factor = 1

    while True:
        with rasterio.open(parent_path) as parent:
            if parent.width <= 512 and parent.height <= 512:
                break
            child_width = (parent.width + 1) // 2
            child_height = (parent.height + 1) // 2
            factor *= 2
            child_path = os.path.join(ctx.tmp_dir, f"{base}_overview_{factor}.tif")
            partial_path = child_path + ".partial"
            # A killed worker can leave either name behind. Never let a digest/cache
            # hit make an incomplete level appear usable on the resumed run.
            for stale_path in (partial_path, child_path):
                try:
                    os.remove(stale_path)
                except FileNotFoundError:
                    pass
            child_profile = profile.copy()
            child_profile.update(
                width=child_width,
                height=child_height,
                transform=parent.transform * rasterio.Affine.scale(2, 2),
            )
            counts = {"0": 0, "1": 0, "255": 0}
            with rasterio.open(partial_path, "w", **child_profile) as child:
                for _, child_window in child.block_windows(1):
                    source_window = Window(
                        int(child_window.col_off) * 2,
                        int(child_window.row_off) * 2,
                        min(int(child_window.width) * 2, parent.width - int(child_window.col_off) * 2),
                        min(int(child_window.height) * 2, parent.height - int(child_window.row_off) * 2),
                    )
                    source_data = parent.read(1, window=source_window)
                    target_height = int(child_window.height) * 2
                    target_width = int(child_window.width) * 2
                    if source_data.shape != (target_height, target_width):
                        padded = np.full((target_height, target_width), NODATA, dtype=np.uint8)
                        padded[:source_data.shape[0], :source_data.shape[1]] = source_data
                        source_data = padded
                    cells = source_data.reshape(
                        int(child_window.height), 2, int(child_window.width), 2
                    )
                    flooded = np.any(cells == 1, axis=(1, 3))
                    observed = np.any(cells != NODATA, axis=(1, 3))
                    pooled = np.where(flooded, 1, np.where(observed, 0, NODATA)).astype(np.uint8)
                    child.write(pooled, 1, window=child_window)
                    counts["0"] += int(np.count_nonzero(pooled == 0))
                    counts["1"] += int(np.count_nonzero(pooled == 1))
                    counts["255"] += int(np.count_nonzero(pooled == NODATA))

            # Reopen before publishing the level. This catches truncated/invalid
            # cached files and proves that even an all-nodata sparse TIFF exists.
            with rasterio.open(partial_path) as check:
                if (check.width, check.height, check.count, check.nodata, check.dtypes[0]) != (
                    child_width, child_height, 1, NODATA, "uint8"
                ):
                    raise RuntimeError(f"Invalid explicit overview artifact: {partial_path}")
                checked_counts = _count_values(check, level_label=f"explicit overview factor {factor}")
            if checked_counts != counts or sum(checked_counts.values()) != child_width * child_height:
                raise RuntimeError(
                    f"Explicit overview count mismatch at factor {factor}: "
                    f"written={counts}, read={checked_counts}"
                )
            os.replace(partial_path, child_path)
            overview_paths.append(child_path)
            expected_counts[str(factor)] = checked_counts
            parent_path = child_path

    return overview_paths, expected_counts


def _write_cog_with_explicit_overviews(intermediate, overview_paths, output, base, ctx):
    vrt_path = os.path.join(ctx.tmp_dir, base + ".vrt")
    partial_output = output + ".partial.tif"
    for stale_path in (vrt_path, partial_output):
        try:
            os.remove(stale_path)
        except FileNotFoundError:
            pass

    # Do not hand GDAL names from a prior interrupted run without reopening
    # every level. Missing, truncated, or nonsensical cached levels force failure
    # before COG creation; the caller's fresh pyramid is then the only input.
    for path in overview_paths:
        if not os.path.isfile(path):
            raise RuntimeError(f"Explicit overview is missing before COG creation: {path}")
        with rasterio.open(path) as cached_level:
            if cached_level.count != 1 or cached_level.nodata != NODATA or cached_level.dtypes[0] != "uint8":
                raise RuntimeError(f"Invalid cached overview layout before COG creation: {path}")

    subprocess.run(
        ["gdal_translate", "-of", "VRT", intermediate, vrt_path],
        cwd=ctx.tmp_dir,
        check=True,
    )
    tree = ET.parse(vrt_path)
    root = tree.getroot()
    band = root.find("VRTRasterBand")
    if band is None:
        raise RuntimeError("Could not find the raster band in the generated VRT")
    for path in overview_paths:
        overview = ET.SubElement(band, "Overview")
        filename = ET.SubElement(overview, "SourceFilename", relativeToVRT="0")
        filename.text = os.path.abspath(path)
        ET.SubElement(overview, "SourceBand").text = "1"
    tree.write(vrt_path, encoding="UTF-8", xml_declaration=True)

    command = [
        "gdal_translate", "-of", "COG", "-a_nodata", str(NODATA),
        "-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=2",
        "-co", "OVERVIEW_COMPRESS=DEFLATE", "-co", "OVERVIEW_PREDICTOR=2",
        "-co", "BLOCKSIZE=512", "-co", "BIGTIFF=IF_SAFER",
        "-co", "OVERVIEWS=FORCE_USE_EXISTING", vrt_path, partial_output,
    ]
    subprocess.run(command, cwd=ctx.tmp_dir, check=True)
    os.replace(partial_output, output)
    os.remove(vrt_path)


def _write_daily_composite(items, day, bbox, ctx):
    unique = list({item["href"]: item for item in items}.values())
    datasets = []
    try:
        aoi_target = transform_bounds("EPSG:4326", TARGET_CRS, *bbox, densify_pts=21)
        covered = []
        for item in unique:
            source = rasterio.open(item["href"])
            datasets.append((item, source))
            if source.crs is None:
                raise RuntimeError(f"GFM source {item['id']} has no CRS")
            if source.count < 1 or source.nodata != NODATA:
                raise RuntimeError(
                    f"Unexpected raster layout for {item['id']}: count={source.count}, nodata={source.nodata}"
                )
            source_bounds = transform_bounds(source.crs, TARGET_CRS, *source.bounds, densify_pts=21)
            overlap = _intersection(source_bounds, aoi_target)
            if overlap:
                covered.append(overlap)

        # Every day uses the same AOI-wide aligned grid. Unwritten sparse tiles read
        # as nodata, so locations outside that day's frame coverage are represented
        # explicitly without making the file proportional to the nodata area.
        left = math.floor(aoi_target[0] / PIXEL_SIZE) * PIXEL_SIZE
        bottom = math.floor(aoi_target[1] / PIXEL_SIZE) * PIXEL_SIZE
        right = math.ceil(aoi_target[2] / PIXEL_SIZE) * PIXEL_SIZE
        top = math.ceil(aoi_target[3] / PIXEL_SIZE) * PIXEL_SIZE
        width = int(round((right - left) / PIXEL_SIZE))
        height = int(round((top - bottom) / PIXEL_SIZE))
        transform = rasterio.transform.from_origin(left, top, PIXEL_SIZE, PIXEL_SIZE)

        base = f"observed_flood_extent_{day.strftime('%Y%m%d')}"
        intermediate = os.path.join(ctx.tmp_dir, base + "_daily.tif")
        output_name = base + ".tif"
        output = os.path.join(ctx.out_dir, output_name)
        profile = {
            "driver": "GTiff", "width": width, "height": height, "count": 1,
            "dtype": "uint8", "crs": TARGET_CRS, "transform": transform,
            "nodata": NODATA, "tiled": True, "blockxsize": 512, "blockysize": 512,
            "compress": "DEFLATE", "predictor": 2, "BIGTIFF": "IF_SAFER",
            "SPARSE_OK": "TRUE",
        }

        with rasterio.open(intermediate, "w+", **profile) as destination:
            for item, source in datasets:
                source_bounds = transform_bounds(source.crs, TARGET_CRS, *source.bounds, densify_pts=21)
                overlap = _intersection(source_bounds, (left, bottom, right, top))
                window = _source_window(overlap, left, top, width, height) if overlap else None
                if window is None:
                    continue
                with WarpedVRT(
                    source, crs=TARGET_CRS, transform=transform, width=width, height=height,
                    src_nodata=NODATA, nodata=NODATA, resampling=Resampling.nearest,
                ) as warped:
                    for strip in _strips(window):
                        incoming = warped.read(1, window=strip)
                        valid = incoming != NODATA
                        if not valid.any():
                            continue
                        unexpected = np.unique(incoming[valid][~np.isin(incoming[valid], (0, 1))])
                        if unexpected.size:
                            raise RuntimeError(
                                f"Unexpected GFM values in {item['id']}: {unexpected.tolist()}"
                            )
                        current = destination.read(1, window=strip)
                        # Flood wins over no-flood in overlaps; an observation wins over nodata.
                        replace = valid & ((current == NODATA) | (incoming > current))
                        current[replace] = incoming[replace]
                        destination.write(current, 1, window=strip)
            destination.update_tags(
                source="Copernicus Global Flood Monitoring STAC",
                source_asset=ASSET,
                observation_day=day.isoformat(),
                compositing="1 if any frame reports flood; 0 if observed without flood; 255 if unobserved",
            )

        with rasterio.open(intermediate) as source:
            full_counts = _count_values(source)
        counts = {"0": full_counts["0"], "1": full_counts["1"]}
        valid_count = counts["0"] + counts["1"]
        if not valid_count:
            print(f"Day {day} has no observed pixels; emitting an AOI-wide nodata snapshot")

        overview_paths, expected_overview_counts = _build_max_pooled_overviews(
            intermediate, base, profile, ctx
        )
        _write_cog_with_explicit_overviews(
            intermediate, overview_paths, output, base, ctx
        )

        overview_counts = {}
        with rasterio.open(output) as check:
            if check.nodata != NODATA or check.count != 1 or check.dtypes[0] != "uint8":
                raise RuntimeError(f"Output validation failed for {output_name}")
            reported_factors = check.overviews(1)
            if len(reported_factors) != len(overview_paths):
                raise RuntimeError(
                    f"Overview level count differs for {output_name}: got {reported_factors}, "
                    f"expected {len(overview_paths)} levels"
                )
            for level, (reported_factor, path) in enumerate(
                zip(reported_factors, overview_paths), start=1
            ):
                nominal_factor = 2 ** level
                with rasterio.open(path) as expected_level:
                    level_width = expected_level.width
                    level_height = expected_level.height
                level_counts = _count_values(
                    check,
                    out_width=level_width,
                    out_height=level_height,
                    level_label=f"overview level {level} (nominal factor {nominal_factor})",
                )
                overview_counts[str(nominal_factor)] = level_counts
                expected = expected_overview_counts[str(nominal_factor)]
                if level_counts != expected:
                    raise RuntimeError(
                        f"Overview level {level} was altered in the COG: "
                        f"got {level_counts}, expected {expected}"
                    )
                if counts["1"] > 0 and level_counts["1"] == 0:
                    raise RuntimeError(
                        f"Flood pixels vanished at overview level {level} for {output_name}"
                    )
                print(
                    f"Verified {day} overview level {level} "
                    f"(nominal factor {nominal_factor}, GDAL factor {reported_factor}, "
                    f"size {level_width}x{level_height}): counts={level_counts}"
                )
            output_bounds = transform_bounds(check.crs, "EPSG:4326", *check.bounds, densify_pts=21)

        os.remove(intermediate)
        for path in overview_paths:
            os.remove(path)
        # The grid is the country/deployment AOI bbox; alignment can extend the file
        # by less than one pixel, while the declared footprint remains the exact AOI.
        footprint = list(bbox)
        start = dt.datetime.combine(day, dt.time.min, tzinfo=dt.timezone.utc)
        end = start + dt.timedelta(days=1)
        print(f"Prepared {day}: {len(unique)} frame(s), {valid_count} observed pixels, counts={counts}")
        return {
            "layerId": LAYER_ID,
            "path": output_name,
            "timestamp": _iso(start),
            "timestampEnd": _iso(end),
            "footprint": footprint,
            "crs": TARGET_CRS,
            "metadata": {
                "source_collection": COLLECTION,
                "source_asset": ASSET,
                "source_item_ids": [item["id"] for item in unique],
                "observation_day_utc": day.isoformat(),
                "composite_rule": "flood_any",
                "pixel_size_metres": PIXEL_SIZE,
                "valid_pixel_count": valid_count,
                "value_counts": counts,
                "overview_resampling": "max_pool_flood_any_observed_any",
                "overview_value_counts": overview_counts,
            },
        }
    finally:
        for _, dataset in datasets:
            dataset.close()


def run(ctx):
    # Before GDAL first sizes its cache; gdal_translate inherits it too.
    os.environ["GDAL_CACHEMAX"] = GDAL_CACHE_MB
    bbox = _aoi_bbox(ctx.definition)
    today = dt.datetime.now(dt.timezone.utc).date()
    end_day = today - dt.timedelta(days=1)
    # History depth applies only when there is no cursor: the first run and a rebuild
    requested_days = int((ctx.params or {}).get("days_back", INITIAL_DAYS))

    prior = dict(ctx.previous_state or {})
    if prior.get("state_version") == STATE_VERSION and prior.get("last_day"):
        start_day = dt.date.fromisoformat(prior["last_day"]) + dt.timedelta(days=1)
        state = prior
    else:
        # A cursor from another format is ignored, so every timestamp in the
        # configured history is replaced
        start_day = today - dt.timedelta(days=requested_days)
        state = {"state_version": STATE_VERSION}
        if prior:
            print("Stored snapshots are in an earlier format: loading the configured history again")

    if start_day > end_day:
        print("No completed UTC day remains to search")
        return {"rasters": [], "state": state, "backlog_remaining": False}

    batch_end = min(end_day, start_day + dt.timedelta(days=MAX_DAYS_PER_RUN - 1))
    backlog_remaining = batch_end < end_day
    print(f"Searching GFM STAC for bbox {bbox}, UTC days {start_day} through {batch_end}")
    groups = _search_days(bbox, start_day, batch_end)
    print(f"Found frames on {len(groups)} of {MAX_DAYS_PER_RUN if backlog_remaining else (batch_end - start_day).days + 1} calendar day(s)")

    # Heavy weeks (many frames per day over a large AOI) can outlast the run
    # timeout. Days are committed as they complete: once the time budget is
    # spent the batch ends early, the cursor stops at the last finished day,
    # and the remainder is picked up next run instead of retried from scratch.
    timeout_ms = int((ctx.definition.get("limits") or {}).get("timeoutMs", 1800000))
    budget_seconds = timeout_ms / 1000 * 0.6
    started_at = time.monotonic()

    rasters = []
    day = start_day
    cursor_day = None
    while day <= batch_end:
        raster = _write_daily_composite(groups.get(day, []), day, bbox, ctx)
        rasters.append(raster)
        cursor_day = day
        day += dt.timedelta(days=1)
        elapsed = time.monotonic() - started_at
        if day <= batch_end and elapsed > budget_seconds:
            print(
                f"Time budget spent after {elapsed:.0f}s; stopping at {cursor_day}, "
                f"{(batch_end - cursor_day).days} day(s) of this batch deferred to the next run"
            )
            break

    backlog_remaining = cursor_day < end_day
    state.update({
        "state_version": STATE_VERSION,
        "last_day": cursor_day.isoformat(),
        "initial_history_days": requested_days,
    })
    print(
        f"Run complete: {len(rasters)} daily snapshot(s), "
        f"backlog_remaining={backlog_remaining}, cursor={state['last_day']}"
    )
    return {
        "rasters": rasters,
        "state": state,
        "backlog_remaining": backlog_remaining,
        "days_examined": (batch_end - start_day).days + 1,
    }
