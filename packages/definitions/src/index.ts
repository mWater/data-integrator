/**
 * Integration definition types: the machine-readable library format.
 *
 * A definition is one file in the versioned integration library. It declares
 * everything about an integration except secret values: source, trigger, AOI,
 * inputs, runtime, limits, destinations, validation rules, and the single
 * self-contained code file implementing the run(ctx) entrypoint.
 *
 * Definitions are templates: aoi, trigger, and limits are defaults that a
 * deployment may override when installing an integration. There is no version
 * field; the server derives definition versions from content.
 *
 * See Architecture.md. Types only for now; validation comes with the server.
 */

// ============================================================================
// Definition
// ============================================================================

/** One integration in the library: source connection, processing code, and destinations. */
export interface IntegrationDefinition {
  /** Published identifier, snake_case (^[a-z][a-z0-9_]{0,62}$). Renaming is creating a new integration. */
  id: string
  /** Human-readable display name */
  name: string
  /** What the integration does and any caveats */
  description?: string
  /** Provenance of the external source; documentation, not behavior. Absent for derived integrations. */
  source?: SourceInfo
  /** How runs are triggered. Default; a deployment may override at install. */
  trigger: Trigger
  /** Names of secrets the code reads via ctx.secrets. Values live in the app DB, never here. */
  secrets?: string[]
  /** Area of interest clipping ingestion and input extracts. Default; a deployment may override at install. */
  aoi?: Aoi
  /** Platform data materialized read-only at /in, keyed by input id */
  inputs?: Record<string, InputRef>
  /** Runtime image the code runs in */
  runtime: RuntimeId
  /** Resource limits for each run. Default; a deployment may override at install. */
  limits?: JobLimitsSpec
  /** Tables and raster layers the integration writes to */
  destinations: Destination[]
  /** Data quality rules evaluated on results (FUC-3) */
  validation?: ValidationSpec
  /** Single self-contained file implementing the entrypoint */
  code: string
  /** Entrypoint contract version */
  contract: 2
}

/** Identifier of a runtime image the job runner can execute. */
export type RuntimeId = "node22" | "python3.12"

/** Provenance of the external data source, for documentation and lineage. */
export interface SourceInfo {
  /** Source name, e.g. "GloFAS river discharge" */
  name: string
  /** Primary URL of the source or its API */
  url?: string
  /** Organization publishing the data */
  provider?: string
  /** License of the source data, e.g. "CC-BY-4.0" */
  license?: string
  /** Link to source documentation */
  documentation?: string
}

/** How runs of the integration are triggered. */
export interface Trigger {
  /** cron expression, UTC */
  cron?: string
  /** Accept webhook payloads, buffered and batched into ctx.webhookData (all pending events, oldest first) */
  webhook?: boolean
}

/** Area of interest that ingestion and input extracts are clipped to. */
export interface Aoi {
  /** [west, south, east, north], EPSG:4326 */
  bbox: [number, number, number, number]
}

/** Per-run resource limits, capped by server configuration. */
export interface JobLimitsSpec {
  /** CPU cores */
  cpus?: number
  /** Memory ceiling in MB */
  memoryMb?: number
  /** Wall-clock timeout in ms */
  timeoutMs?: number
  /** Quota for the persistent /work workspace in MB */
  workDiskMb?: number
}

// ============================================================================
// Inputs (materialized at /in; see Architecture.md)
// ============================================================================

/** Reference to platform data materialized read-only at /in. */
export type InputRef = RasterInputRef | TableInputRef

/** Catalog raster snapshots delivered to the job as COG files. */
export interface RasterInputRef {
  /** Discriminator */
  kind: "raster"
  /** Catalog layer to read */
  layerId: string
  /** Which snapshots to materialize */
  select: SnapshotSelect
}

/**
 * Platform table extract delivered to the job as a file.
 * Extracts are select/filter/clip only, never aggregation. Size-capped by the server.
 */
export interface TableInputRef {
  /** Discriminator */
  kind: "table"
  /** Table to extract from */
  tableId: string
  /** Columns to include; absent = all */
  columns?: string[]
  /** Row filter applied before extraction */
  where?: FilterSpec
  /**
   * Extract file format. Default by runtime: gpkg for python3.12, json for node22.
   * json is an array of row objects: dates as ISO strings, geometry columns as
   * GeoJSON geometry objects.
   */
  format?: "gpkg" | "json" | "csv"
}

/** Snapshot selector: the current one, the latest N, or a time range. */
export type SnapshotSelect =
  | "current"
  | { latest: number }
  | { from: string; to?: string }

/** Conjunction of simple column comparisons; no aggregation, no joins. */
export type FilterSpec = {
  /** Column to compare */
  column: string
  /** Comparison operator */
  op: "=" | "!=" | ">" | ">=" | "<" | "<=" | "in"
  /** Comparison value ("in" takes an array) */
  value: unknown
}[]

// ============================================================================
// Input manifest (what the server materialized at /in)
// ============================================================================

/**
 * Contents of /in/manifest.json, written by the server at job launch when the
 * definition declares inputs. Authoritative about paths; conventionally rasters
 * land as /in/<inputId>/<timestamp>.tif and table extracts as /in/<inputId>.<ext>.
 */
export interface InManifest {
  /** Materialized inputs keyed by input id, matching definition.inputs */
  inputs: Record<string, InManifestInput>
}

/** One materialized input: raster snapshots or a table extract. */
export type InManifestInput = RasterInManifestInput | TableInManifestInput

/** Raster input as materialized: one COG file per selected snapshot. */
export interface RasterInManifestInput {
  /** Discriminator */
  kind: "raster"
  /** Catalog layer the snapshots came from */
  layerId: string
  /** Materialized snapshots, ascending by timestamp */
  snapshots: InManifestSnapshot[]
}

/** One materialized catalog snapshot file. */
export interface InManifestSnapshot {
  /** Path relative to /in */
  path: string
  /** Catalog snapshot id, recorded on the run for lineage */
  snapshotId: string
  /** Observation time (or period start) of the snapshot */
  timestamp: string
  /** Period end when the snapshot covers a range */
  timestampEnd?: string
  /** Band ids in file band order (1-based index = position + 1) */
  bands: string[]
}

/** Table input as materialized: a single extract file. */
export interface TableInManifestInput {
  /** Discriminator */
  kind: "table"
  /** Table the extract came from */
  tableId: string
  /** Path relative to /in */
  path: string
  /** Format the extract was written in */
  format: "gpkg" | "json" | "csv"
  /** Rows in the extract */
  rowCount: number
}

// ============================================================================
// Destinations
// ============================================================================

/** Where integration results land: a table or a raster layer. */
export type Destination = TableDestination | RasterLayerDestination

/** Tabular destination; rows arrive via RunResult.data keyed by tableId. */
export interface TableDestination {
  /** Discriminator */
  kind: "table"
  /** Destination table, created/managed by the server; snake_case, becomes the table name in the data schema */
  tableId: string
  /** How incoming rows are applied */
  action: "replace" | "append" | "merge"
  /** Key columns identifying a row; required when action is "merge" */
  mergeColumns?: string[]
  /** Schema of the destination table */
  columns: ColumnSpec[]
}

/** One column of a destination table. */
export interface ColumnSpec {
  /** Column id, lowercase snake case */
  id: string
  /** Human-readable display name */
  name?: string
  /** Value type of the column; integer is exact (bigint), number is floating point */
  type: "text" | "number" | "integer" | "boolean" | "date" | "datetime" | "geometry" | "enum" | "json"
  /** Permitted codes when type is "enum": the harmonization target for source codings (FUC-2). Stored as text; out-of-vocabulary values flag the run. */
  enumValues?: { id: string; name: string }[]
  /** Measurement units, e.g. "mm/day" */
  units?: string
}

/** Raster catalog destination; artifacts arrive via RunResult.rasters. */
export interface RasterLayerDestination {
  /** Discriminator */
  kind: "raster"
  /** Catalog layer to write snapshots into; snake_case, appears in tile and API URLs */
  layerId: string
  /** Human-readable display name */
  name?: string
  /** time-series retains promoted snapshots as history; current-only prunes superseded */
  temporality: "time-series" | "current-only"
  /** Bands of the layer */
  bands: BandSpec[]
}

/** One band of a raster layer. */
export interface BandSpec {
  /** Band id, stable key used in tile and query URLs */
  id: string
  /** Human-readable display name */
  name?: string
  /** Measurement units, e.g. "m3/s" */
  units?: string
  /** Stored as Float32 COGs; NaN when absent */
  nodata?: number
  /** How the band renders as map tiles */
  rendering?: BandRendering
}

/** Map rendering configuration for a band. */
export interface BandRendering {
  /** Value-to-color stops for gdaldem color-relief */
  colorMap?: { value: number; color: string }[]
  /** Default value range for display scaling */
  defaultRange?: { min: number; max: number }
  /** Overview resampling; nearest avoids inflating sparse data */
  resampling?: "nearest" | "average"
}

// ============================================================================
// Validation rules (FUC-3)
// ============================================================================

/** Data quality rules the server evaluates on each run's results. */
export interface ValidationSpec {
  /** Expected data cadence for freshness monitoring, ISO-8601 duration (e.g. "P1D") */
  expectedCadence?: string
  /** Range checks on result values */
  ranges?: RangeRule[]
}

/** Allowed value range for a column or band; violations flag the run. */
export interface RangeRule {
  /** Destination the rule applies to: a tableId or layerId */
  destinationId: string
  /** Column id (tables) or band id (raster layers) within the destination */
  field: string
  /** Minimum allowed value */
  min?: number
  /** Maximum allowed value */
  max?: number
}

// ============================================================================
// Run result (what run(ctx) returns; harness serializes this to stdout)
// ============================================================================

/** Return value of run(ctx); the harness serializes it to stdout. */
export interface RunResult {
  /** Rows per destination table id */
  data?: Record<string, Record<string, unknown>[]>
  /** Raster artifacts written to /out, to be registered in the catalog */
  rasters?: RasterArtifact[]
  /** Next incremental state, persisted and passed as previousState */
  state?: Record<string, unknown>
}

/** One raster file produced by a run, registered as a catalog snapshot. */
export interface RasterArtifact {
  /** Destination layer the snapshot belongs to */
  layerId: string
  /** Path relative to /out */
  path: string
  /** Observation time (or period start) of this snapshot */
  timestamp: string
  /** Period end when the snapshot covers a range */
  timestampEnd?: string
  /** [west, south, east, north], EPSG:4326; server derives from the file when absent */
  footprint?: [number, number, number, number]
  /** CRS of the file, e.g. "EPSG:4326"; server derives from the file when absent */
  crs?: string
  /** Free-form metadata stored on the snapshot */
  metadata?: Record<string, unknown>
}
