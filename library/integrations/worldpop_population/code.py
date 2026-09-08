import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timezone

import requests
import rasterio

CATALOG_URL = "https://hub.worldpop.org/rest/data/pop"
DATA_ROOT = "https://data.worldpop.org/"
NODATA = -99999.0
ENCODING_VERSION = "deflate_predictor_no_v1"
# The executor injects the deployment AOI. This is used only by the draft sandbox,
# whose certification deployment is Madagascar and does not inject an AOI.
CERTIFICATION_AOI = {"bbox": [43.257, -25.571, 50.483, -12.08], "countries": ["MDG"]}


def _get_json(session, url):
    response = session.get(url, timeout=90)
    response.raise_for_status()
    return response.json()


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


def _runtime_aoi(ctx):
    params = ctx.params or {}
    aoi = ctx.definition.get("aoi") or {}
    countries = params.get("countries") or aoi.get("countries")
    bbox = params.get("bbox") or aoi.get("bbox")
    if isinstance(countries, str):
        countries = [part.strip() for part in countries.split(",") if part.strip()]
    if not countries and not bbox:
        print("No AOI was injected in the draft sandbox; using the MDG certification AOI")
        countries = CERTIFICATION_AOI["countries"]
        bbox = CERTIFICATION_AOI["bbox"]
    if not countries:
        raise ValueError(
            "WorldPop 100 m files are country-keyed. Set params.countries or use an AOI "
            "with ISO3 country codes."
        )
    if not bbox or len(bbox) != 4:
        raise ValueError("The runtime AOI must include bbox [west, south, east, north]")
    countries = sorted({str(code).upper() for code in countries})
    if any(not re.fullmatch(r"[A-Z]{3}", code) for code in countries):
        raise ValueError("countries must contain ISO3 codes")
    bbox = [float(value) for value in bbox]
    if not (bbox[0] < bbox[2] and bbox[1] < bbox[3]):
        raise ValueError("Invalid AOI bbox")
    return countries, bbox


def _records(session, release, countries):
    by_year = {}
    for country in countries:
        payload = _get_json(session, f"{CATALOG_URL}/{release}?iso3={country}")
        rows = [row for row in payload.get("data", []) if row.get("iso3") == country]
        if not rows:
            raise RuntimeError(f"WorldPop release {release} has no records for {country}")
        for row in rows:
            year = int(row["popyear"])
            files = row.get("files") or []
            path = files[0] if files else row.get("data_file")
            if not path:
                print(f"Skipping {country} {year}: catalog record has no data file")
                continue
            url = path if path.startswith("http") else DATA_ROOT + path.lstrip("/")
            by_year.setdefault(year, []).append((country, url))
    expected = set(countries)
    complete = {
        year: items
        for year, items in by_year.items()
        if {country for country, _ in items} == expected
    }
    incomplete = sorted(set(by_year) - set(complete))
    if incomplete:
        print(f"Skipping years without every requested country: {incomplete}")
    if not complete:
        raise RuntimeError("No complete WorldPop years are available for the requested countries")
    return complete


def _download(session, url, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return
    part = path + ".part"
    print(f"Downloading {url}")
    with session.get(url, stream=True, timeout=(30, 300)) as response:
        response.raise_for_status()
        with open(part, "wb") as output:
            for chunk in response.iter_content(1024 * 1024):
                if chunk:
                    output.write(chunk)
    os.replace(part, path)


def _run_command(args, cwd):
    print("Running:", " ".join(args))
    subprocess.run(args, cwd=cwd, check=True)


def run(ctx):
    countries, bbox = _runtime_aoi(ctx)
    session = requests.Session()
    session.headers.update({"User-Agent": "Pathfinder-WorldPop/1.0"})
    release = _latest_release(session)
    records = _records(session, release, countries)
    previous = ctx.previous_state or {}
    if (
        previous.get("release") == release
        and previous.get("countries") == countries
        and previous.get("bbox") == bbox
        and previous.get("encodingVersion") == ENCODING_VERSION
    ):
        completed = {int(year) for year in previous.get("years", [])}
    else:
        completed = set()
    pending = sorted(set(records) - completed)
    print(f"WorldPop release {release}; countries={countries}; available={sorted(records)}; pending={pending}")
    if not pending:
        return {"state": previous}

    cache_root = os.path.join(ctx.work_dir, "worldpop", release)
    os.makedirs(cache_root, exist_ok=True)
    os.makedirs(ctx.out_dir, exist_ok=True)
    rasters = []
    produced = set(completed)
    current_year = datetime.now(timezone.utc).year

    for year in pending:
        local_files = []
        for country, url in records[year]:
            filename = os.path.basename(url)
            local_path = os.path.join(cache_root, country, str(year), filename)
            _download(session, url, local_path)
            with rasterio.open(local_path) as source:
                if source.crs is None or source.crs.to_epsg() != 4326:
                    raise RuntimeError(f"Unexpected CRS in {country} {year}: {source.crs}")
            local_files.append(local_path)

        vrt_path = os.path.join(ctx.work_dir, f"population_{year}.vrt")
        if len(local_files) == 1:
            source_path = local_files[0]
        else:
            _run_command(["gdalbuildvrt", "-srcnodata", str(NODATA), "-vrtnodata", str(NODATA), vrt_path] + local_files, ctx.work_dir)
            source_path = vrt_path

        output_name = f"population_{year}.tif"
        output_path = os.path.join(ctx.out_dir, output_name)
        if os.path.exists(output_path):
            os.remove(output_path)
        west, south, east, north = bbox
        _run_command([
            "gdalwarp", "-of", "COG", "-te_srs", "EPSG:4326",
            "-te", str(west), str(south), str(east), str(north),
            "-r", "near", "-srcnodata", str(NODATA), "-dstnodata", str(NODATA),
            "-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=NO",
            "-co", "BLOCKSIZE=512", "-co", "BIGTIFF=IF_SAFER",
            "-co", "OVERVIEW_RESAMPLING=NEAREST",
            source_path, output_path
        ], ctx.work_dir)
        with rasterio.open(output_path) as result:
            stats = result.statistics(1, approx=True)
            print(f"Produced {output_name}: {result.width}x{result.height}, nodata={result.nodata}, stats={stats}")
            if result.nodata != NODATA:
                raise RuntimeError(f"Output nodata mismatch for {year}")
        rasters.append({
            "layerId": "population",
            "path": output_name,
            "timestamp": f"{year}-01-01T00:00:00Z",
            "timestampEnd": f"{year + 1}-01-01T00:00:00Z",
            "footprint": bbox,
            "crs": "EPSG:4326",
            "metadata": {
                "source": "WorldPop Global 2",
                "release": release,
                "countries": countries,
                "populationYear": year,
                "modeledProjection": year > current_year,
                "units": "people per grid cell"
            }
        })
        produced.add(year)

    return {
        "rasters": rasters,
        "state": {
            "release": release,
            "encodingVersion": ENCODING_VERSION,
            "countries": countries,
            "bbox": bbox,
            "years": sorted(produced),
            "checkedAt": datetime.now(timezone.utc).isoformat()
        }
    }
