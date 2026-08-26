---
name: Writing COG outputs
description: GDAL COG driver in the sandbox - the read-only-cwd trap, compression choices, and when to warp vs translate
verified: 2026-08-26
---

# Writing Cloud Optimized GeoTIFFs in the sandbox

Raster artifacts must be COGs in /out. The GDAL CLI is the reliable way to
produce them, with two sandbox-specific traps.

## The working-directory trap

**GDAL's COG driver writes temporary intermediate files relative to the
process working directory**, and the container rootfs is read-only, so
`gdalwarp -of COG` (and sometimes `gdal_translate -of COG` on large inputs)
fails with an unhelpful nonzero exit when cwd is not writable. Run GDAL
subprocesses with `cwd` set beside the destination (or in /work):

    subprocess.run(args, cwd=os.path.dirname(output_path), ...)

The alternative that also works: write a plain tiled GTiff first, then
`gdal_translate -of COG` from /work to /out.

## Command shapes that work

- Mosaic: `gdalbuildvrt` over the source tiles, then one `gdalwarp` doing
  clip + CRS + nodata in a single pass:
  `-of COG -te <west south east north> -dstnodata <sentinel>`
- Compression: `-co COMPRESS=DEFLATE` always; `-co PREDICTOR=2` for integer
  bands, `PREDICTOR=FLOATING_POINT` for float. `-co BIGTIFF=IF_SAFER` when
  the mosaic can pass 4 GB; `-co BLOCKSIZE=512`.
- Keep the native grid unless the destination declares otherwise; warping
  to EPSG:4326 is for sources already in it, not a default.

## Discipline

- Always set and **declare** nodata: `-dstnodata` on the file and `nodata`
  on the band, the same value. Missing declarations poison SQL statistics
  and map transparency.
- Print progress if you like: the harness redirects all subprocess output
  to the log channel, so it cannot corrupt the result.
