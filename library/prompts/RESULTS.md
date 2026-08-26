# Validation results

One row per design session run from a standardized prompt. Outcome is
"first try" (finished from the prompt alone), "steered" (operator
clarifications only), or "skill" (a skill was written or extended and the
session restarted).

| Date | Prompt | Outcome | Steers | Skills used/added | Session notes |
|---|---|---|---|---|---|
| 2026-08-26 | ghsl_built_up | steered | 1 (confirmed 2020 observed epoch vs modeled) | none | Session ~7 min, CLI, model openai/gpt-5.6-sol. Agent self-fixed 2 test failures (tile zip layout; GDAL progress on stdout corrupting the job JSON). Cold-certified, finished as ghs_built_surface. First production load exposed platform gaps, not agent errors: raster-SQL registration rejects ESRI:54009 and fails the run; scratch certification skips registration so the cold run could not catch it; CLI finish fire-and-forgets the first load (reaper cleaned it up correctly). Band nodata (65535) in the COG but not declared on the band. |
| 2026-08-26 | ghsl_built_up (fixes + verify) | pass | 1 (approved nodata metadata edit) | none | Platform fixes applied (spatial_ref_sys SRID lookup incl. ESRI codes, scratch registration validation, CLI awaits first load). Edit session added band nodata (v2), cold-certified. Production load succeeded: 2,368 SQL tiles at SRID 54009. Acceptance checks all pass (Antananarivo 5,566 m2/cell, sea nodata, max 9,806, CC BY 4.0 recorded). Entry exported to library/integrations/ghs_built_surface. UpCloud verification pending. |
| 2026-08-26 | copernicus_dem_glo30 | steered | 1 (approved plan) | none at design; source+technique skills written after | Self-fixed one warm failure (GDAL COG driver temp files vs read-only cwd; captured in new cog_output skill). Certified, first load 4.4 min, 69 tiles / ~2.5 GB. Acceptance pass (Antananarivo 1,271 m, seams smooth, sea/coast sane). Metadata gaps repeated (no band nodata, no colorMap -> blank map): designer prompt now REQUIRES both; styling fixed in follow-up edit session (v2, 8-stop ramp). Also exposed: tile URLs immutable across restyles (fixed: style hash in disk key + URL), dev-serve env mismatch (symlinked store). copernicus_dem_source skill written. Exported to library. UpCloud verification pending. |
