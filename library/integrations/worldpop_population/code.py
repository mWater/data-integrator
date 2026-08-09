import subprocess
from pathlib import Path

import rasterio
import requests

URL = "https://data.worldpop.org/GIS/Population/Global_2000_2020_1km_UNadj/2020/{iso3}/{iso3l}_ppp_2020_1km_Aggregated_UNadj.tif"


def run(ctx):
    iso3 = ((ctx.params or {}).get("country") or "MDG").upper()
    src = Path(ctx.work_dir) / f"{iso3}_ppp_2020_1km.tif"
    if not src.exists():
        print(f"downloading WorldPop {iso3}")
        with requests.get(URL.format(iso3=iso3, iso3l=iso3.lower()), stream=True, timeout=600) as r:
            r.raise_for_status()
            tmp = src.with_suffix(".part")
            with open(tmp, "wb") as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)
            tmp.rename(src)
    else:
        print(f"using cached {src.name}")

    out = f"{ctx.out_dir}/pop.tif"
    cmd = ["gdal_translate", "-q"]
    aoi = (ctx.definition.get("aoi") or {}).get("bbox")
    if aoi:
        west, south, east, north = aoi
        cmd += ["-projwin", str(west), str(north), str(east), str(south)]
    cmd += ["-of", "COG", "-co", "COMPRESS=DEFLATE", "-co", "RESAMPLING=NEAREST", str(src), out]
    subprocess.run(cmd, check=True)

    with rasterio.open(out) as ds:
        b = ds.bounds
    return {
        "rasters": [
            {
                "layerId": "worldpop_population",
                "path": "pop.tif",
                "timestamp": "2020-01-01T00:00:00Z",
                "timestampEnd": "2020-12-31T23:59:59Z",
                "footprint": [b.left, b.bottom, b.right, b.top],
                "crs": "EPSG:4326",
                "metadata": {"country": iso3, "product": "ppp_2020_1km_Aggregated_UNadj"},
            }
        ]
    }
