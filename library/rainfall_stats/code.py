import json

import numpy as np
import rasterio
from rasterio.warp import Resampling, reproject
from rasterio.windows import from_bounds


def run(ctx):
    manifest = json.load(open(f"{ctx.in_dir}/manifest.json"))
    pop_snap = manifest["inputs"]["pop"]["snapshots"][0]
    rain_snaps = manifest["inputs"]["rain"]["snapshots"]
    done = set((ctx.previous_state or {}).get("months") or [])

    with rasterio.open(f"{ctx.in_dir}/{pop_snap['path']}") as pop_ds:
        pop = pop_ds.read(1).astype("float64")
        pop[~np.isfinite(pop) | (pop < 0)] = 0
        if pop_ds.nodata is not None:
            pop[pop == pop_ds.nodata] = 0
        pop_bounds = pop_ds.bounds
        pop_transform = pop_ds.transform
        pop_crs = pop_ds.crs

    rows = []
    months = list(done)
    pop_on_rain = None
    for snap in rain_snaps:
        month = snap["timestamp"][:7]
        if month in done:
            print(f"{month} already processed")
            continue
        with rasterio.open(f"{ctx.in_dir}/{snap['path']}") as rain_ds:
            window = from_bounds(*pop_bounds, transform=rain_ds.transform).round_offsets().round_lengths()
            rain = rain_ds.read(1, window=window).astype("float64")
            nodata = rain_ds.nodata if rain_ds.nodata is not None else -9999.0
            if pop_on_rain is None:
                # Population is a count: aggregate onto the rain grid sum-preserving
                pop_on_rain = np.zeros(rain.shape, dtype="float64")
                reproject(
                    source=pop,
                    destination=pop_on_rain,
                    src_transform=pop_transform,
                    src_crs=pop_crs,
                    dst_transform=rain_ds.window_transform(window),
                    dst_crs=rain_ds.crs,
                    resampling=Resampling.sum,
                )

        valid = (rain != nodata) & np.isfinite(rain) & (pop_on_rain > 0)
        if not valid.any():
            print(f"{month}: no overlapping data, skipping")
            continue
        total_pop = float(pop_on_rain[valid].sum())
        rows.append({
            "month": f"{month}-01",
            "mean_mm": round(float(rain[valid].mean()), 2),
            "pop_weighted_mm": round(float((rain[valid] * pop_on_rain[valid]).sum() / total_pop), 2),
            "population": int(round(total_pop)),
        })
        months.append(month)
        print(f"{month}: mean {rows[-1]['mean_mm']} mm, pop-weighted {rows[-1]['pop_weighted_mm']} mm")

    return {"data": {"rainfall_stats": rows}, "state": {"months": sorted(set(months))}}
