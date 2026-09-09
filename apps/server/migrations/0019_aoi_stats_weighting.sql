-- Area-weighted statistics of one raster layer over the area of interest.
--   layer_id   the layer (data.rasters.layer_id)
--   at         the date to report on: the latest snapshot starting on or
--              before it (null means the newest snapshot)
--   threshold  with op, the condition whose share of the area is reported
--              (e.g. threshold -1, op '<' gives the share in drought)
--   op         one of < <= > >= =
--   band       band index, 1-based
-- Returns one row: mean (area-weighted), share (area meeting the condition,
-- null without a threshold), coverage (share of the area's land with a
-- valid pixel), cells (valid pixels counted), cell_km2 (pixel area at the
-- area's centre), method ('exact' when each pixel is weighted by the part of
-- it inside the boundary, 'clip' when pixels are fine enough that whole-pixel
-- clipping is within a fraction of a percent; pixels are then weighted by
-- their area at their own latitude, in strips of at most half a degree),
-- observed_at and observed_end of the snapshot used, and boundary (source
-- and version of the shape). Nodata and NaN pixels are never counted.
-- SECURITY DEFINER so the read-only role can reach the layer's declared
-- nodata in app.raster_layers.
CREATE OR REPLACE FUNCTION data.aoi_stats(
  layer_id text,
  at timestamptz DEFAULT NULL,
  threshold float8 DEFAULT NULL,
  op text DEFAULT '<',
  band integer DEFAULT 1
) RETURNS TABLE (
  mean float8,
  share float8,
  coverage float8,
  cells bigint,
  cell_km2 float8,
  method text,
  observed_at timestamptz,
  observed_end timestamptz,
  boundary text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = data, public
AS $$
DECLARE
  aoi_geom geometry;
  aoi_km2 float8;
  aoi_boundary text;
  obs_at timestamptz;
  obs_end timestamptz;
  declared_nodata float8;
  px_w float8;
  px_h float8;
  cx float8;
  cy float8;
  px_km2 float8;
  est_cells float8;
  strip_rows integer;
  -- Above this many pixels, exact per-pixel intersection is too slow for an
  -- interactive query, and the whole-pixel error is already negligible
  exact_limit constant float8 := 25000;
BEGIN
  IF op NOT IN ('<', '<=', '>', '>=', '=') THEN
    RAISE EXCEPTION 'aoi_stats: op must be one of < <= > >= =, got %', op;
  END IF;

  SELECT a.geom, a.land_area_km2, a.boundary_source || ' ' || a.boundary_version
    INTO aoi_geom, aoi_km2, aoi_boundary
  FROM data.aoi a;
  IF aoi_geom IS NULL THEN
    RAISE EXCEPTION 'aoi_stats: no area of interest is configured for this deployment';
  END IF;

  SELECT r.observed_at, r.observed_end INTO obs_at, obs_end
  FROM data.rasters r
  WHERE r.layer_id = aoi_stats.layer_id
    AND (aoi_stats.at IS NULL OR r.observed_at <= aoi_stats.at)
  ORDER BY r.observed_at DESC
  LIMIT 1;
  IF obs_at IS NULL THEN
    -- Nothing on or before the date: the earliest snapshot is the honest answer
    SELECT r.observed_at, r.observed_end INTO obs_at, obs_end
    FROM data.rasters r WHERE r.layer_id = aoi_stats.layer_id
    ORDER BY r.observed_at ASC LIMIT 1;
  END IF;
  IF obs_at IS NULL THEN
    RAISE EXCEPTION 'aoi_stats: layer % has no registered snapshots', aoi_stats.layer_id;
  END IF;

  SELECT (b ->> 'nodata')::float8 INTO declared_nodata
  FROM app.raster_layers l, jsonb_array_elements(l.bands) WITH ORDINALITY AS t(b, i)
  WHERE l.id = aoi_stats.layer_id AND t.i = aoi_stats.band;

  SELECT abs(ST_PixelWidth(r.rast)), abs(ST_PixelHeight(r.rast)) INTO px_w, px_h
  FROM data.rasters r
  WHERE r.layer_id = aoi_stats.layer_id AND r.observed_at = obs_at
  LIMIT 1;
  SELECT ST_X(c), ST_Y(c) INTO cx, cy FROM (SELECT ST_Centroid(aoi_geom) AS c) s;
  px_km2 := ST_Area(ST_MakeEnvelope(cx, cy, cx + px_w, cy + px_h, 4326)::geography) / 1e6;
  est_cells := ST_Area(aoi_geom::geography) / 1e6 / px_km2;

  IF est_cells <= exact_limit THEN
    RETURN QUERY
    WITH tiles AS (
      SELECT CASE
               WHEN ST_BandNoDataValue(r.rast, aoi_stats.band) IS NULL AND declared_nodata IS NOT NULL
               THEN ST_SetBandNoDataValue(r.rast, aoi_stats.band, declared_nodata)
               ELSE r.rast
             END AS rast
      FROM data.rasters r
      WHERE r.layer_id = aoi_stats.layer_id AND r.observed_at = obs_at
        AND ST_Intersects(ST_ConvexHull(r.rast), aoi_geom)
    ),
    -- Every pixel whose square touches the boundary counts, weighted by the
    -- part inside; ST_Clip would keep only pixels whose centre is inside and
    -- drop the coastal half-cells
    px AS (
      SELECT (pp).val AS val, (pp).geom AS geom
      FROM tiles t, LATERAL ST_PixelAsPolygons(t.rast, aoi_stats.band, true) pp
      WHERE ST_Intersects((pp).geom, aoi_geom)
    ),
    weighted AS (
      SELECT p.val, ST_Area(ST_Intersection(p.geom, aoi_geom)::geography) / 1e6 AS km2
      FROM px p
      WHERE p.val = p.val AND p.val IS NOT NULL AND (declared_nodata IS NULL OR p.val <> declared_nodata)
    )
    SELECT
      sum(w.val * w.km2) / NULLIF(sum(w.km2), 0),
      CASE WHEN threshold IS NULL THEN NULL ELSE
        sum(w.km2) FILTER (WHERE
          (op = '<'  AND w.val <  threshold) OR (op = '<=' AND w.val <= threshold) OR
          (op = '>'  AND w.val >  threshold) OR (op = '>=' AND w.val >= threshold) OR
          (op = '='  AND w.val =  threshold)) / NULLIF(sum(w.km2), 0)
      END,
      sum(w.km2) / aoi_km2,
      count(*)::bigint,
      px_km2,
      'exact'::text,
      obs_at,
      obs_end,
      aoi_boundary
    FROM weighted w
    WHERE w.km2 > 0;
  ELSE
    -- Whole pixels, but a lat/lon pixel near the equator is larger than one
    -- near the pole: cut each clipped tile into strips no taller than half a
    -- degree and weight every strip's pixels by the cell area at its latitude
    strip_rows := greatest(1, floor(0.5 / px_h))::integer;
    RETURN QUERY
    WITH tiles AS (
      SELECT ST_Clip(
               CASE
                 WHEN ST_BandNoDataValue(r.rast, aoi_stats.band) IS NULL AND declared_nodata IS NOT NULL
                 THEN ST_SetBandNoDataValue(r.rast, aoi_stats.band, declared_nodata)
                 ELSE r.rast
               END, aoi_stats.band, aoi_geom, true) AS rast
      FROM data.rasters r
      WHERE r.layer_id = aoi_stats.layer_id AND r.observed_at = obs_at
        AND ST_Intersects(ST_ConvexHull(r.rast), aoi_geom)
    ),
    strips AS (
      SELECT s.rast, ST_Y(ST_Centroid(ST_Envelope(s.rast))) AS lat
      FROM tiles t, LATERAL ST_Tile(t.rast, 1, ST_Width(t.rast), strip_rows) s(rast)
      WHERE NOT ST_IsEmpty(t.rast)
    ),
    stats AS (
      SELECT (ST_SummaryStats(s.rast, 1, true)).count AS n,
             (ST_SummaryStats(s.rast, 1, true)).mean AS m,
             -- The hit raster keeps the input's nodata value, which an 8-bit
             -- band clamps to 0 (a miss): declare 255 as nodata explicitly
             CASE WHEN threshold IS NULL THEN NULL ELSE
               (ST_SummaryStats(ST_SetBandNoDataValue(ST_MapAlgebra(s.rast, 1, '8BUI',
                  format('CASE WHEN [rast] %s %s THEN 1 ELSE 0 END', op, threshold), 255), 1, 255), 1, true)).mean
             END AS hit,
             ST_Area(ST_MakeEnvelope(0, s.lat - px_h / 2, px_w, s.lat + px_h / 2, 4326)::geography) / 1e6 AS km2
      FROM strips s
    )
    SELECT
      sum(s.m * s.n * s.km2) / NULLIF(sum(s.n * s.km2), 0),
      CASE WHEN threshold IS NULL THEN NULL ELSE sum(s.hit * s.n * s.km2) / NULLIF(sum(s.n * s.km2), 0) END,
      sum(s.n * s.km2) / aoi_km2,
      sum(s.n)::bigint,
      px_km2,
      'clip'::text,
      obs_at,
      obs_end,
      aoi_boundary
    FROM stats s;
  END IF;
END
$$;

GRANT EXECUTE ON FUNCTION data.aoi_stats(text, timestamptz, float8, text, integer) TO sql_engine;
