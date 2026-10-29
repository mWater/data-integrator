import os
import re
import shutil
import subprocess
import time
from datetime import datetime, timezone

import requests
import rasterio

# WorldPop Global 2 constrained population counts: one file per country per year, discovered
# from the hub catalogue. Two modes, decided by the runtime AOI:
#   country mode - the AOI names countries: their files are mosaicked and clipped to the AOI
#                  box into one COG per year (a deployment's usual case);
#   world mode   - no AOI at all (the platform's "full extent"): every country's file is
#                  re-encoded to its own COG and a year is one snapshot of ~240 sources. A
#                  global mosaic would be a 432,000 x 216,000 pixel file and is never built.
CATALOG_URL = "https://hub.worldpop.org/rest/data/pop"
DATA_ROOT = "https://data.worldpop.org/"
NODATA = -99999.0
ENCODING_VERSION = "deflate_predictor_no_v1"
WORLD_BBOX = [-180.0, -90.0, 180.0, 90.0]
COG_OPTIONS = [
    "-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=NO",
    "-co", "BLOCKSIZE=512", "-co", "BIGTIFF=IF_SAFER",
    "-co", "OVERVIEW_RESAMPLING=NEAREST",
]


RETRIES = 4


def _retrying(label, action):
    """Runs action() up to RETRIES times: the hub and data servers drop connections now and
    then, and a global year is hundreds of requests."""
    for attempt in range(1, RETRIES + 1):
        try:
            return action()
        except (requests.RequestException, OSError) as error:
            if attempt == RETRIES:
                raise
            wait = 5 * attempt
            print(f"{label}: {error.__class__.__name__}, retrying in {wait}s ({attempt}/{RETRIES})")
            time.sleep(wait)


def _get_json(session, url):
    def fetch():
        response = session.get(url, timeout=90)
        response.raise_for_status()
        return response.json()

    return _retrying(url, fetch)


def _latest_release(session):
    categories = _get_json(session, CATALOG_URL).get("data", [])
    candidates = []
    for item in categories:
        alias = item.get("alias", "")
        match = re.fullmatch(r"G2_CN_POP_R(\d{2})([A-Z])_100m", alias)
        if match:
            candidates.append(((int(match.group(1)), match.group(2)), alias))
    if not candidates:
        raise RuntimeError("WorldPop catalog has no Global 2 constrained 100 m release")
    return max(candidates)[1]


def _parse_codes(value):
    if isinstance(value, str):
        value = [part.strip() for part in value.split(",") if part.strip()]
    codes = sorted({str(code).upper() for code in value or []})
    if any(not re.fullmatch(r"[A-Z]{3}", code) for code in codes):
        raise ValueError("countries must contain ISO3 codes")
    return codes


def _runtime_scope(ctx):
    """(mode, countries, bbox) from the injected AOI. Country codes come from the AOI; no AOI
    means the whole world. A bare box cannot be served: WorldPop files are country-keyed and
    guessing countries from a box is not safe."""
    aoi = ctx.definition.get("aoi") or {}
    countries = _parse_codes(aoi.get("countries"))
    bbox = aoi.get("bbox")
    if bbox is not None:
        if len(bbox) != 4:
            raise ValueError("bbox must be [west, south, east, north]")
        bbox = [float(value) for value in bbox]
        if not (bbox[0] < bbox[2] and bbox[1] < bbox[3]):
            raise ValueError("Invalid AOI bbox")
    if countries:
        return "country", countries, bbox
    if bbox is not None:
        raise ValueError(
            "WorldPop 100 m files are country-keyed and this AOI is a bare box. "
            "Choose an area of interest by country."
        )
    return "world", None, None


def _release_listing(session, release):
    """{year: sorted ISO3 codes} for every record in the release (one request, no file URLs)."""
    payload = _get_json(session, f"{CATALOG_URL}/{release}")
    by_year = {}
    for row in payload.get("data", []):
        try:
            year = int(row["popyear"])
        except (KeyError, TypeError, ValueError):
            continue
        code = str(row.get("iso3") or "").upper()
        if re.fullmatch(r"[A-Z]{3}", code):
            by_year.setdefault(year, set()).add(code)
    if not by_year:
        raise RuntimeError(f"WorldPop release {release} lists no records")
    return {year: sorted(codes) for year, codes in by_year.items()}


def _country_files(session, release, country):
    """{year: file URL} for one country."""
    payload = _get_json(session, f"{CATALOG_URL}/{release}?iso3={country}")
    rows = [row for row in payload.get("data", []) if row.get("iso3") == country]
    if not rows:
        raise RuntimeError(f"WorldPop release {release} has no records for {country}")
    files = {}
    for row in rows:
        year = int(row["popyear"])
        paths = row.get("files") or []
        path = paths[0] if paths else row.get("data_file")
        if not path:
            print(f"Skipping {country} {year}: catalog record has no data file")
            continue
        files[year] = path if path.startswith("http") else DATA_ROOT + path.lstrip("/")
    return files


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
    subprocess.run(args, cwd=cwd, check=True)


def _check_source(path, label):
    with rasterio.open(path) as source:
        if source.crs is None or source.crs.to_epsg() != 4326:
            raise RuntimeError(f"Unexpected CRS in {label}: {source.crs}")


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


def _select_years(available, choice, mode, current_year):
    """Years to produce, from the years setting. "auto" takes every published year for a
    country AOI (a deployment wants its full series) and only the current year for the world,
    since each global year is about 10 GB of source and 3.5 GB stored."""
    if choice == "all" or (choice == "auto" and mode == "country"):
        return sorted(available)
    at_or_before = [year for year in available if year <= current_year]
    return [max(at_or_before)] if at_or_before else [min(available)]


def _country_year(session, release, countries, bbox, year, cache_root, tmp_dir, out_dir, urls_by_country):
    """Country mode: mosaic the countries' files and clip to the box into one COG."""
    local_files = []
    for country in countries:
        url = urls_by_country[country][year]
        local_path = os.path.join(cache_root, country, str(year), os.path.basename(url))
        _download(session, url, local_path)
        _check_source(local_path, f"{country} {year}")
        local_files.append(local_path)

    if len(local_files) == 1:
        source_path = local_files[0]
    else:
        source_path = os.path.join(tmp_dir, f"population_{year}.vrt")
        _run_command(["gdalbuildvrt", "-srcnodata", str(NODATA), "-vrtnodata", str(NODATA), source_path] + local_files, tmp_dir)

    output_name = f"population_{year}.tif"
    output_path = os.path.join(out_dir, output_name)
    if os.path.exists(output_path):
        os.remove(output_path)
    clip = ["-te_srs", "EPSG:4326", "-te"] + [str(value) for value in bbox] if bbox else []
    _run_command(
        ["gdalwarp", "-of", "COG", *clip, "-r", "near", "-srcnodata", str(NODATA), "-dstnodata", str(NODATA),
         *COG_OPTIONS, source_path, output_path],
        tmp_dir,
    )
    footprint = _check_output(output_path)
    return {"path": output_name, "footprint": bbox or footprint}


def _world_year(session, release, countries, year, cache_root, tmp_dir, out_dir):
    """World mode: one COG per country, cached across runs so an interrupted year resumes.
    The source download is dropped once its COG exists, keeping disk near the stored size."""
    cog_dir = os.path.join(cache_root, "cog", str(year))
    os.makedirs(cog_dir, exist_ok=True)
    sources = []
    missing = []
    for index, country in enumerate(countries, 1):
        name = f"population_{year}_{country.lower()}.tif"
        cached = os.path.join(cog_dir, name)
        if not os.path.exists(cached):
            urls = _country_files(session, release, country)
            if year not in urls:
                missing.append(country)
                continue
            url = urls[year]
            local_path = os.path.join(cache_root, country, str(year), os.path.basename(url))
            _download(session, url, local_path)
            _check_source(local_path, f"{country} {year}")
            partial = cached + ".part.tif"
            _run_command(
                ["gdal_translate", "-q", "-of", "COG", "-a_nodata", str(NODATA), *COG_OPTIONS, local_path, partial],
                tmp_dir,
            )
            os.replace(partial, cached)
            os.remove(local_path)
            print(f"{country} {year}: encoded ({index}/{len(countries)})")
        footprint = _check_output(cached)
        sources.append({"path": _place_in_out(cached, out_dir, name), "footprint": footprint})
    if missing:
        print(f"{year}: no file for {missing}")
    return sources, missing


def run(ctx):
    mode, countries, bbox = _runtime_scope(ctx)
    years_choice = (ctx.params or {}).get("years", "auto")
    session = requests.Session()
    session.headers.update({"User-Agent": "DataIntegrator-WorldPop/1.0"})
    release = _latest_release(session)
    listing = _release_listing(session, release)
    current_year = datetime.now(timezone.utc).year

    urls_by_country = {}
    if mode == "country":
        for country in countries:
            urls_by_country[country] = _country_files(session, release, country)
        available = sorted(year for year in listing if all(year in urls_by_country[c] for c in countries))
        incomplete = sorted(set(listing) - set(available))
        if incomplete:
            print(f"Skipping years without every requested country: {incomplete}")
        if not available:
            raise RuntimeError("No complete WorldPop years are available for the requested countries")
        scope_key = {"mode": mode, "countries": countries, "bbox": bbox}
    else:
        available = sorted(listing)
        scope_key = {"mode": mode, "countries": None, "bbox": None}

    wanted = _select_years(available, years_choice, mode, current_year)
    previous = ctx.previous_state or {}
    same_scope = (
        previous.get("release") == release
        and previous.get("encodingVersion") == ENCODING_VERSION
        and all(previous.get(key) == value for key, value in scope_key.items())
    )
    completed = {int(year) for year in previous.get("years", [])} if same_scope else set()
    pending = [year for year in wanted if year not in completed]
    scope_label = f"{len(listing[max(listing)])} countries (world)" if mode == "world" else f"countries={countries}"
    print(f"WorldPop release {release}; {scope_label}; available={available}; wanted={wanted}; pending={pending}")
    state = {
        "release": release,
        "encodingVersion": ENCODING_VERSION,
        **scope_key,
        "years": sorted(completed),
        "checkedAt": datetime.now(timezone.utc).isoformat(),
    }
    if not pending:
        return {"state": state}

    cache_root = os.path.join(ctx.work_dir, "worldpop", release)
    os.makedirs(cache_root, exist_ok=True)
    os.makedirs(ctx.out_dir, exist_ok=True)
    rasters = []
    produced = set(completed)

    for year in pending:
        metadata = {
            "source": "WorldPop Global 2",
            "release": release,
            "mode": mode,
            "populationYear": year,
            "modeledProjection": year > current_year,
            "units": "people per grid cell",
        }
        if mode == "country":
            artifact = _country_year(session, release, countries, bbox, year, cache_root, ctx.tmp_dir, ctx.out_dir, urls_by_country)
            metadata["countries"] = countries
            raster = {"layerId": "population", **artifact}
        else:
            sources, missing = _world_year(session, release, listing[year], year, cache_root, ctx.tmp_dir, ctx.out_dir)
            metadata["countries"] = len(sources)
            if missing:
                metadata["missingCountries"] = missing
            raster = {"layerId": "population", "sources": sources, "footprint": WORLD_BBOX}
        raster.update({
            "timestamp": f"{year}-01-01T00:00:00Z",
            "timestampEnd": f"{year + 1}-01-01T00:00:00Z",
            "crs": "EPSG:4326",
            "metadata": metadata,
        })
        rasters.append(raster)
        produced.add(year)

    state["years"] = sorted(produced)
    return {"rasters": rasters, "state": state}
