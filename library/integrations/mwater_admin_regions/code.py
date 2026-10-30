import hashlib
import os
import re
from pathlib import Path

import geopandas as gpd
import pandas as pd
import requests
from shapely.geometry import box


RELEASES_BASE = "https://data.mwater.co/admin-regions"
REGION_COLUMNS = [
    "id", "iso3", "level", "name", "local_name", "full_name", "type", "local_type", "leaf",
    "parent_id", "level0", "level1", "level2", "level3", "level4", "level5", "source",
]


def _runtime_selection(ctx):
    """Countries come from the AOI's country list, then the AOI bbox. No AOI at all (the
    platform's "full source extent") means every published country."""
    aoi = ctx.definition.get("aoi") or {}
    countries = aoi.get("countries")
    bbox = aoi.get("bbox")
    if countries:
        countries = sorted({str(code).upper() for code in countries})
        if any(not re.fullmatch(r"[A-Z]{3}", code) for code in countries):
            raise ValueError("countries must contain ISO3 codes")
    return countries, bbox


def _countries_from_bbox(manifest, bbox):
    """Every country whose published bounding box touches the AOI bbox."""
    west, south, east, north = [float(v) for v in bbox]
    parts = [box(west, south, east, north)] if west <= east else [box(west, south, 180, north), box(-180, south, east, north)]
    selected = []
    for entry in manifest["countries"]:
        if not entry.get("bbox") or not entry.get("file"):
            continue
        w, s, e, n = entry["bbox"]
        country_box = box(w, s, e, n)
        if any(part.intersects(country_box) for part in parts):
            selected.append(entry["iso3"])
    return sorted(selected)


def _resolve_release(session, version):
    """The pinned release when the version setting names one, else whatever latest.json names."""
    if version:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(version)):
            raise ValueError("The release version must be a date like 2026-09-07")
        manifest_url = f"{RELEASES_BASE}/releases/{version}/manifest.json"
    else:
        latest = session.get(f"{RELEASES_BASE}/latest.json", timeout=60)
        latest.raise_for_status()
        manifest_url = latest.json()["manifest"]
    response = session.get(manifest_url, timeout=60)
    response.raise_for_status()
    return response.json()


def _download(session, url, target, expected_bytes, expected_sha256):
    """Cache in /work, trusting a cached file only when its size and checksum match the manifest."""
    if target.exists() and target.stat().st_size == expected_bytes and _sha256(target) == expected_sha256:
        return target
    temporary = target.with_suffix(target.suffix + ".part")
    with session.get(url, stream=True, timeout=(30, 300)) as response:
        response.raise_for_status()
        with open(temporary, "wb") as stream:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    stream.write(chunk)
    if temporary.stat().st_size != expected_bytes or _sha256(temporary) != expected_sha256:
        temporary.unlink(missing_ok=True)
        raise IOError(f"Download did not match the manifest checksum: {url}")
    os.replace(temporary, target)
    return target


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _make_valid(frame, label):
    invalid_before = int((~frame.geometry.is_valid).sum())
    if invalid_before:
        frame = frame.copy()
        frame.geometry = frame.geometry.make_valid()
        invalid_after = int((~frame.geometry.is_valid).sum())
        if invalid_after:
            raise ValueError(f"{label}: {invalid_after} geometries remain invalid after make_valid")
        print(f"  {label}: repaired {invalid_before} invalid geometries")
    return frame


def run(ctx):
    params = ctx.params or {}
    session = requests.Session()
    session.headers["User-Agent"] = "DataIntegrator-mWater-Admin-Regions/1.0"

    manifest = _resolve_release(session, params.get("version", ""))
    release = manifest["version"]
    by_iso3 = {entry["iso3"]: entry for entry in manifest["countries"]}

    countries, bbox = _runtime_selection(ctx)
    if not countries and bbox:
        countries = _countries_from_bbox(manifest, bbox)
        print(f"Countries intersecting the AOI bbox: {', '.join(countries) or 'none'}")
        if not countries:
            raise ValueError("The area of interest matches no published country. Choose it by country instead.")
    if not countries:
        countries = sorted(iso3 for iso3, entry in by_iso3.items() if entry.get("file"))
        print(f"No AOI configured; loading all {len(countries)} published countries")

    layer = "admin_regions_simplified" if params.get("simplified") else "admin_regions"
    cache_dir = Path(ctx.work_dir) / "mwater_admin_regions" / release
    cache_dir.mkdir(parents=True, exist_ok=True)
    os.makedirs(ctx.out_dir, exist_ok=True)
    regions_path = Path(ctx.out_dir) / "admin_regions.gpkg"
    regions_path.unlink(missing_ok=True)

    # One country at a time, appended to the output file, so a whole-world load never holds
    # more than one country's geometry in memory
    loaded = []
    total = 0
    for iso3 in countries:
        entry = by_iso3.get(iso3)
        if not entry or not entry.get("file"):
            print(f"  {iso3}: not in release {release} (or has no geometry), skipped")
            continue
        info = entry["file"]
        path = _download(session, manifest["baseUrl"] + info["path"], cache_dir / f"{iso3}.gpkg", info["bytes"], info["sha256"])
        frame = gpd.read_file(path, layer=layer)
        if frame.crs is None or frame.crs.to_epsg() != 4326:
            frame = frame.to_crs("EPSG:4326")
        frame = _make_valid(frame, iso3)
        frame["leaf"] = frame["leaf"].astype(bool)
        frame["release"] = release
        frame = frame[REGION_COLUMNS + ["release", "geometry"]]
        frame.to_file(regions_path, driver="GPKG", layer="admin_regions", mode="a" if loaded else "w", index=False)
        print(f"  {iso3} {entry['name']}: {len(frame)} regions, levels {sorted(int(k) for k in entry['counts'])}")
        loaded.append(iso3)
        total += len(frame)
    if not loaded:
        raise ValueError(f"None of {', '.join(countries)} are published in release {release}")

    levels_url = manifest["baseUrl"] + manifest["files"]["levels"]["path"]
    levels = pd.read_csv(levels_url)
    levels = levels[levels["iso3"].isin(set(loaded))]
    levels_path = Path(ctx.out_dir) / "admin_region_levels.csv"
    levels.to_csv(levels_path, index=False)
    print(f"Loaded {total} regions across {len(loaded)} countries and {len(levels)} level names from release {release} ({layer})")

    return {
        "tables": [
            {"tableId": "admin_regions", "path": regions_path.name, "format": "gpkg"},
            {"tableId": "admin_region_levels", "path": levels_path.name, "format": "csv"},
        ],
        "state": {"release": release, "countries": loaded, "layer": layer},
    }
