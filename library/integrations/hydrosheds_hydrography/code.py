import os
import zipfile
from pathlib import Path

import geopandas as gpd
import pandas as pd
import requests
from shapely.geometry import box


REGIONS = ("af", "ar", "as", "au", "eu", "gr", "na", "sa", "si")
BASE = "https://data.hydrosheds.org/file"


def _aoi_parts(bbox):
    west, south, east, north = [float(v) for v in bbox]
    if not (-90 <= south < north <= 90):
        raise ValueError(f"Invalid deployment AOI latitude bounds: {bbox}")
    if west <= east:
        return [box(west, south, east, north)]
    # Also support a deployment AOI encoded across the antimeridian.
    return [box(west, south, 180, north), box(-180, south, east, north)]


def _download(session, url, cache_dir):
    """Use /work only as a validated cache; the remote Content-Length is authoritative."""
    target = cache_dir / url.rsplit("/", 1)[-1]
    head = session.head(url, timeout=60, allow_redirects=True)
    head.raise_for_status()
    expected = int(head.headers.get("content-length", "0") or 0)
    if target.exists() and expected > 0 and target.stat().st_size == expected:
        return target

    temporary = target.with_suffix(target.suffix + ".part")
    with session.get(url, stream=True, timeout=(30, 300)) as response:
        response.raise_for_status()
        with open(temporary, "wb") as stream:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    stream.write(chunk)
    if expected > 0 and temporary.stat().st_size != expected:
        temporary.unlink(missing_ok=True)
        raise IOError(f"Incomplete HydroSHEDS download: {url}")
    os.replace(temporary, target)
    return target


def _shapefile_path(zip_path):
    with zipfile.ZipFile(zip_path) as archive:
        names = [name for name in archive.namelist() if name.lower().endswith(".shp")]
    if len(names) != 1:
        raise ValueError(f"Expected one shapefile in {zip_path.name}, found {len(names)}")
    return f"zip://{zip_path}!{names[0]}"


def _read_intersections(zip_path, aoi_parts, columns=None):
    source = _shapefile_path(zip_path)
    pieces = []
    for aoi in aoi_parts:
        frame = gpd.read_file(source, bbox=aoi.bounds, columns=columns)
        if not frame.empty:
            frame = frame[frame.geometry.notna() & frame.geometry.intersects(aoi)].copy()
            if not frame.empty:
                pieces.append(frame)
    if not pieces:
        return gpd.GeoDataFrame(geometry=[], crs="EPSG:4326")
    result = gpd.GeoDataFrame(pd.concat(pieces, ignore_index=True), crs=pieces[0].crs)
    return result.to_crs("EPSG:4326") if result.crs and result.crs.to_epsg() != 4326 else result


def _select_regions(session, cache_dir, aoi_parts):
    selected = []
    for region in REGIONS:
        url = f"{BASE}/HydroBASINS/standard/hybas_{region}_lev01_v1c.zip"
        archive = _download(session, url, cache_dir)
        if not _read_intersections(archive, aoi_parts, columns=[]).empty:
            selected.append(region)
    return selected


def _make_geometries_valid(frame, label):
    """Repair source geometry defects and reject any geometry still invalid afterward."""
    result = frame.copy()
    invalid_before = int((~result.geometry.is_valid).sum())
    result.geometry = result.geometry.make_valid()
    invalid_after = int((~result.geometry.is_valid).sum())
    if invalid_after:
        raise ValueError(f"{invalid_after} {label} geometries remain invalid after make_valid")
    print(f"Repaired {invalid_before} invalid {label} geometries")
    return result


def _basins(raw):
    result = raw.rename(columns={
        "HYBAS_ID": "hybas_id",
        "NEXT_DOWN": "next_down_id",
        "NEXT_SINK": "next_sink_id",
        "MAIN_BAS": "main_basin_id",
        "PFAF_ID": "pfaf_id",
        "SUB_AREA": "subbasin_area_sq_km",
        "UP_AREA": "upstream_area_sq_km",
        "DIST_SINK": "distance_to_sink_km",
        "ENDO": "endorheic",
        "COAST": "coastal",
        "ORDER": "basin_order",
    })
    result["endorheic"] = result["endorheic"].eq(1)
    result["coastal"] = result["coastal"].eq(1)
    columns = [
        "hybas_id", "next_down_id", "next_sink_id", "main_basin_id", "pfaf_id",
        "subbasin_area_sq_km", "upstream_area_sq_km", "distance_to_sink_km",
        "endorheic", "coastal", "basin_order", "geometry",
    ]
    return result[columns].drop_duplicates("hybas_id").reset_index(drop=True)


def _rivers(raw):
    result = raw.rename(columns={
        "HYRIV_ID": "hyriv_id",
        "NEXT_DOWN": "next_down_id",
        "MAIN_RIV": "main_river_id",
        "HYBAS_L12": "hydrobasins_level12_id",
        "LENGTH_KM": "length_km",
        "DIST_DN_KM": "distance_downstream_km",
        "CATCH_SKM": "local_catchment_sq_km",
        "UPLAND_SKM": "upstream_drainage_area_sq_km",
        "DIS_AV_CMS": "average_discharge_cms",
        "ENDORHEIC": "endorheic",
        "ORD_STRA": "strahler_order",
    })
    result["endorheic"] = result["endorheic"].eq(1)
    columns = [
        "hyriv_id", "next_down_id", "main_river_id", "hydrobasins_level12_id",
        "length_km", "distance_downstream_km", "local_catchment_sq_km",
        "upstream_drainage_area_sq_km", "average_discharge_cms", "endorheic",
        "strahler_order", "geometry",
    ]
    return result[columns].drop_duplicates("hyriv_id").reset_index(drop=True)


def run(ctx):
    definition_aoi = ctx.definition.get("aoi")
    if not definition_aoi or not definition_aoi.get("bbox"):
        raise ValueError("This integration requires a deployment AOI with a bbox.")
    aoi_parts = _aoi_parts(definition_aoi["bbox"])

    cache_dir = Path(ctx.work_dir) / "hydrosheds_downloads"
    cache_dir.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers["User-Agent"] = "DataIntegrator-HydroSHEDS/1.0"

    regions = _select_regions(session, cache_dir, aoi_parts)
    if not regions:
        raise ValueError("The deployment AOI does not intersect land represented by HydroSHEDS.")
    print(f"HydroSHEDS regions intersecting AOI: {', '.join(regions)}")

    basin_frames = []
    river_frames = []
    basin_source_columns = [
        "HYBAS_ID", "NEXT_DOWN", "NEXT_SINK", "MAIN_BAS", "PFAF_ID", "SUB_AREA",
        "UP_AREA", "DIST_SINK", "ENDO", "COAST", "ORDER",
    ]
    river_source_columns = [
        "HYRIV_ID", "NEXT_DOWN", "MAIN_RIV", "HYBAS_L12", "LENGTH_KM", "DIST_DN_KM",
        "CATCH_SKM", "UPLAND_SKM", "DIS_AV_CMS", "ENDORHEIC", "ORD_STRA",
    ]
    for region in regions:
        basin_url = f"{BASE}/HydroBASINS/standard/hybas_{region}_lev08_v1c.zip"
        river_url = f"{BASE}/HydroRIVERS/HydroRIVERS_v10_{region}_shp.zip"
        basin_frames.append(_read_intersections(
            _download(session, basin_url, cache_dir), aoi_parts, basin_source_columns
        ))
        river_frames.append(_read_intersections(
            _download(session, river_url, cache_dir), aoi_parts, river_source_columns
        ))

    basin_raw = gpd.GeoDataFrame(pd.concat(basin_frames, ignore_index=True), crs="EPSG:4326")
    river_raw = gpd.GeoDataFrame(pd.concat(river_frames, ignore_index=True), crs="EPSG:4326")
    if basin_raw.empty:
        raise ValueError("No level-8 HydroBASINS features intersect the deployment AOI.")

    basins = _make_geometries_valid(_basins(basin_raw), "basin")
    rivers = _rivers(river_raw) if not river_raw.empty else gpd.GeoDataFrame(
        columns=[c["id"] for c in ctx.definition["destinations"][1]["columns"]],
        geometry="geometry", crs="EPSG:4326"
    )
    rivers = _make_geometries_valid(rivers, "river")

    basin_path = Path(ctx.out_dir) / "hydrobasins.fgb"
    river_path = Path(ctx.out_dir) / "hydrorivers.fgb"
    basins.to_file(basin_path, driver="FlatGeobuf", index=False)
    rivers.to_file(river_path, driver="FlatGeobuf", index=False)
    print(f"Selected {len(basins)} basins and {len(rivers)} river reaches")

    return {
        "tables": [
            {"tableId": "hydrobasins", "path": basin_path.name, "format": "fgb"},
            {"tableId": "hydrorivers", "path": river_path.name, "format": "fgb"},
        ]
    }
