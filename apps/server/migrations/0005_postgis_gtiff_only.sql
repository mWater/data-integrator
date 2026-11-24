-- PostGIS opens rasters through GDAL, and 0001 enabled every GDAL driver. The
-- raster store holds only GeoTIFFs, so only that driver is needed; the others
-- include ones that read arbitrary local files or fetch URLs.
-- A superuser setting: when the migrating role may not set it, the deploy
-- scripts' superuser step does (deploy/setup.sh, deploy/update.sh).
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET postgis.gdal_enabled_drivers = %L', current_database(), 'GTiff');
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'Could not restrict the PostGIS GDAL drivers; run as superuser: ALTER DATABASE % SET postgis.gdal_enabled_drivers = ''GTiff'';', current_database();
END
$$;
