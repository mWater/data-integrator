import hashlib
import os
import re
import time
from pathlib import Path

import geopandas as gpd
import pandas as pd
import requests


# The open release only: gbHumanitarian and gbAuthoritative carry less open terms
API_BASE = "https://www.geoboundaries.org/api/current/gbOpen"
# Placeholder strings the API uses for a value it does not have
EMPTY_VALUES = {"", "nan", "none", "null", "unknown"}
BOUNDARY_COLUMNS = [
    "shape_id", "iso3", "level", "name", "subdivision_code", "level_name", "year", "source", "license", "boundary_id",
]
LEVEL_COLUMNS = [
    "iso3", "country", "level", "level_name", "units", "year", "source", "license", "license_url", "source_url",
    "boundary_id", "build_date",
]


def _countries(ctx):
    """ISO3 codes from the AOI's country list, or None for the whole world (no AOI). A bare
    box cannot be served: the files are country-keyed and guessing countries from a box is
    not safe."""
    aoi = ctx.definition.get("aoi") or {}
    countries = aoi.get("countries")
    if countries:
        countries = sorted({str(code).upper() for code in countries})
        if any(not re.fullmatch(r"[A-Z]{3}", code) for code in countries):
            raise ValueError("countries must contain ISO3 codes")
        return countries
    if aoi.get("bbox") is not None:
        raise ValueError(
            "geoBoundaries files are country-keyed and this AOI is a bare box. "
            "Choose an area of interest by country."
        )
    return None


def _get(session, url, **kwargs):
    """GET with a few retries: the API and the file host both answer 5xx now and then."""
    for attempt in range(4):
        try:
            response = session.get(url, **kwargs)
            if response.status_code < 500:
                return response
            problem = f"HTTP {response.status_code}"
            response.close()
        except requests.RequestException as err:
            problem = str(err)
        if attempt == 3:
            raise IOError(f"{url}: {problem}")
        time.sleep(5 * (attempt + 1))


def _listing(session, countries):
    """Boundary records (one per country and level) for the countries, or for every country."""
    if countries is None:
        response = _get(session, f"{API_BASE}/ALL/ALL/", timeout=120)
        response.raise_for_status()
        return response.json()
    records = []
    for iso3 in countries:
        response = _get(session, f"{API_BASE}/{iso3}/ALL/", timeout=60)
        if response.status_code == 404:
            print(f"  {iso3}: not in geoBoundaries, skipped")
            continue
        response.raise_for_status()
        payload = response.json()
        # One level comes back as a bare object, several as a list
        records.extend(payload if isinstance(payload, list) else [payload])
    return records


def _text(value):
    """The API's value as text, or None for its placeholders ("nan", "Unknown")."""
    if value is None:
        return None
    text = str(value).strip()
    return None if text.lower() in EMPTY_VALUES else text


def _level(record):
    match = re.fullmatch(r"ADM(\d)", str(record.get("boundaryType", "")))
    if not match:
        raise ValueError(f"Unexpected boundaryType {record.get('boundaryType')!r} for {record.get('boundaryID')}")
    return int(match.group(1))


def _download(session, url, cache_dir, boundary_id):
    """Cache in /work. Download URLs name a commit of the geoBoundaries repository, so a file
    cached under its URL never goes stale; a new release has a new URL."""
    target = cache_dir / f"{boundary_id}-{hashlib.sha1(url.encode()).hexdigest()[:12]}.geojson"
    if target.exists() and target.stat().st_size > 0:
        return target
    for stale in cache_dir.glob(f"{boundary_id}-*"):
        stale.unlink(missing_ok=True)
    temporary = target.with_suffix(".part")
    response = _get(session, url, stream=True, timeout=(30, 300))
    with response:
        response.raise_for_status()
        with open(temporary, "wb") as stream:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    stream.write(chunk)
    os.replace(temporary, target)
    return target


def _read(path, label):
    """One boundary file as EPSG:4326 with valid geometries. A file that cannot be parsed is
    dropped from the cache so the next run downloads it again."""
    try:
        frame = gpd.read_file(path)
    except Exception:
        Path(path).unlink(missing_ok=True)
        raise
    if frame.crs is None:
        frame = frame.set_crs("EPSG:4326")
    elif frame.crs.to_epsg() != 4326:
        frame = frame.to_crs("EPSG:4326")
    frame = frame[~frame.geometry.isna() & ~frame.geometry.is_empty]
    invalid_before = int((~frame.geometry.is_valid).sum())
    if invalid_before:
        frame = frame.copy()
        frame.geometry = frame.geometry.make_valid()
        invalid_after = int((~frame.geometry.is_valid).sum())
        if invalid_after:
            raise ValueError(f"{label}: {invalid_after} geometries remain invalid after make_valid")
        print(f"  {label}: repaired {invalid_before} invalid geometries")
    return frame


def _column(frame, name):
    """A feature property as text with the API's placeholders nulled; absent in some files."""
    if name not in frame.columns:
        return pd.Series([None] * len(frame), index=frame.index, dtype="object")
    return frame[name].map(_text)


def run(ctx):
    params = ctx.params or {}
    simplified = bool(params.get("simplified"))
    max_level = int(params.get("max_level", 5))
    session = requests.Session()
    session.headers["User-Agent"] = "DataIntegrator-geoBoundaries/1.0"

    countries = _countries(ctx)
    if countries is None:
        print("No AOI configured; loading every country in geoBoundaries")
    records = [record for record in _listing(session, countries) if _level(record) <= max_level]
    records.sort(key=lambda record: (record["boundaryISO"], _level(record)))
    if not records:
        raise ValueError(
            f"geoBoundaries has no boundaries up to level {max_level} for "
            f"{', '.join(countries) if countries else 'any country'}"
        )

    cache_dir = Path(ctx.work_dir) / "geoboundaries" / ("simplified" if simplified else "full")
    cache_dir.mkdir(parents=True, exist_ok=True)
    os.makedirs(ctx.out_dir, exist_ok=True)
    boundaries_path = Path(ctx.out_dir) / "admin_boundaries.gpkg"
    boundaries_path.unlink(missing_ok=True)

    # One file at a time, appended to the output, so a whole-world load never holds more than
    # one country level in memory
    levels = []
    urls = {}
    total = 0
    for record in records:
        boundary_id = record["boundaryID"]
        iso3 = record["boundaryISO"]
        level = _level(record)
        url = record["simplifiedGeometryGeoJSON"] if simplified else record["gjDownloadURL"]
        frame = _read(_download(session, url, cache_dir, boundary_id), boundary_id)
        if frame.empty:
            print(f"  {boundary_id}: no geometries, skipped")
            continue

        out = gpd.GeoDataFrame(
            {
                "shape_id": _column(frame, "shapeID"),
                "iso3": iso3,
                "level": level,
                "name": _column(frame, "shapeName"),
                "subdivision_code": _column(frame, "shapeISO"),
                "level_name": _text(record.get("boundaryCanonical")),
                "year": _text(record.get("boundaryYearRepresented")),
                "source": _text(record.get("boundarySource")),
                "license": _text(record.get("boundaryLicense")),
                "boundary_id": boundary_id,
            },
            geometry=frame.geometry,
            crs="EPSG:4326",
        )
        if out["shape_id"].isna().any():
            raise ValueError(f"{boundary_id}: {int(out['shape_id'].isna().sum())} features have no shapeID")
        out = out[BOUNDARY_COLUMNS + ["geometry"]]
        out.to_file(boundaries_path, driver="GPKG", layer="admin_boundaries", mode="a" if urls else "w", index=False)

        levels.append({
            "iso3": iso3,
            "country": _text(record.get("boundaryName")),
            "level": level,
            "level_name": _text(record.get("boundaryCanonical")),
            "units": len(out),
            "year": _text(record.get("boundaryYearRepresented")),
            "source": _text(record.get("boundarySource")),
            "license": _text(record.get("boundaryLicense")),
            "license_url": _text(record.get("licenseSource")),
            "source_url": _text(record.get("boundarySourceURL")),
            "boundary_id": boundary_id,
            "build_date": _text(record.get("buildDate")),
        })
        urls[boundary_id] = url
        total += len(out)
        print(f"  {iso3} level {level}: {len(out)} boundaries ({record.get('boundaryLicense')}; {record.get('boundarySource')})")

    if not urls:
        raise ValueError("None of the listed boundary files held any geometry")

    levels_path = Path(ctx.out_dir) / "admin_boundary_levels.csv"
    pd.DataFrame(levels, columns=LEVEL_COLUMNS).to_csv(levels_path, index=False)
    loaded = sorted({row["iso3"] for row in levels})
    licenses = sorted({row["license"] for row in levels if row["license"]})
    print(
        f"Loaded {total} boundaries in {len(levels)} country levels across {len(loaded)} countries "
        f"({'simplified' if simplified else 'full'} geometry). Licenses: {'; '.join(licenses)}"
    )

    return {
        "tables": [
            {"tableId": "admin_boundaries", "path": boundaries_path.name, "format": "gpkg"},
            {"tableId": "admin_boundary_levels", "path": levels_path.name, "format": "csv"},
        ],
        "state": {"countries": loaded, "simplified": simplified, "maxLevel": max_level, "files": urls},
    }
