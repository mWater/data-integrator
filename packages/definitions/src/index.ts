/**
 * Integration definition types: the machine-readable library format.
 *
 * A definition is one file in the versioned integration library. It declares
 * everything about an integration except secret values: source, trigger, AOI,
 * inputs, runtime, limits, destinations, state shape, validation rules, and the
 * single self-contained code file implementing the run(ctx) entrypoint.
 *
 * See Architecture.md. Types only for now; validation comes with the server.
 */

// ============================================================================
// Definition
// ============================================================================

export interface IntegrationDefinition {
  /** Stable identifier, lowercase kebab or snake case */
  id: string
  name: string
  description?: string
  /** Provenance of the external source; documentation, not behavior */
  source: SourceInfo
  /** How runs are triggered */
  trigger: Trigger
  /** Names of secrets the code reads via ctx.secrets. Values live in the app DB, never here. */
  secrets?: string[]
  /** Area of interest; ingestion and input extracts are clipped to it */
  aoi?: Aoi
  /** Platform data materialized read-only at /in, keyed by input id */
  inputs?: Record<string, InputRef>
  runtime: RuntimeId
  limits?: JobLimitsSpec
  /** Optional hostname allowlist tightening the default public-only egress */
  egress?: EgressSpec
  destinations: Destination[]
  /** Shape of the incremental state carried between runs (ctx.previousState) */
  stateFields?: StateFieldSpec[]
  /** Data quality rules evaluated on results (FUC-3) */
  validation?: ValidationSpec
  /** Single self-contained file implementing the entrypoint */
  code: string
  /** Entrypoint contract version */
  contract: 2
}

export type RuntimeId = "node22" | "python3.12"

export interface SourceInfo {
  name: string
  url?: string
  provider?: string
  /** License of the source data, e.g. "CC-BY-4.0" */
  license?: string
  documentation?: string
}

export interface Trigger {
  /** cron expression, UTC */
  cron?: string
  /** Accept webhook payloads, buffered and passed as ctx.webhookData */
  webhook?: boolean
}

export interface Aoi {
  /** [west, south, east, north], EPSG:4326 */
  bbox?: [number, number, number, number]
  /** GeoJSON Polygon or MultiPolygon, EPSG:4326. Takes precedence over bbox. */
  geometry?: unknown
}

export interface JobLimitsSpec {
  cpus?: number
  memoryMb?: number
  timeoutMs?: number
  /** Quota for the persistent /work workspace */
  workDiskMb?: number
}

export interface EgressSpec {
  /** Hostnames the job may reach; absent = all public internet */
  allowHosts: string[]
}

export interface StateFieldSpec {
  id: string
  type: "text" | "number" | "boolean" | "datetime" | "json"
  description?: string
}

// ============================================================================
// Inputs (materialized at /in; see Architecture.md)
// ============================================================================

export type InputRef = RasterInputRef | TableInputRef

export interface RasterInputRef {
  kind: "raster"
  layerId: string
  select: SnapshotSelect
  /** Band ids to include; absent = all */
  bands?: string[]
}

/** Extracts are select/filter/clip only, never aggregation. Size-capped by the server. */
export interface TableInputRef {
  kind: "table"
  tableId: string
  columns?: string[]
  where?: FilterSpec
  /** Default gpkg */
  format?: "gpkg" | "geojson" | "csv"
}

export type SnapshotSelect =
  | "current"
  | { latest: number }
  | { from: string; to?: string }

/** Conjunction of simple column comparisons */
export type FilterSpec = {
  column: string
  op: "=" | "!=" | ">" | ">=" | "<" | "<=" | "in"
  value: unknown
}[]

// ============================================================================
// Destinations
// ============================================================================

export type Destination = TableDestination | RasterLayerDestination

export interface TableDestination {
  kind: "table"
  tableId: string
  action: "replace" | "append" | "merge"
  /** Required when action is "merge" */
  mergeColumns?: string[]
  columns: ColumnSpec[]
}

export interface ColumnSpec {
  id: string
  name?: string
  type: "text" | "number" | "boolean" | "date" | "datetime" | "geometry" | "enum" | "json"
  enumValues?: { id: string; name: string }[]
  units?: string
}

export interface RasterLayerDestination {
  kind: "raster"
  layerId: string
  name?: string
  /** time-series retains promoted snapshots as history; current-only prunes superseded */
  temporality: "time-series" | "current-only"
  bands: BandSpec[]
}

export interface BandSpec {
  id: string
  name?: string
  units?: string
  /** Stored as Float32 COGs; NaN when absent */
  nodata?: number
  rendering?: BandRendering
}

export interface BandRendering {
  colorMap?: { value: number; color: string }[]
  defaultRange?: { min: number; max: number }
  resampling?: "nearest" | "average"
}

// ============================================================================
// Validation rules (FUC-3)
// ============================================================================

export interface ValidationSpec {
  /** Expected data cadence for freshness monitoring, ISO-8601 duration (e.g. "P1D") */
  expectedCadence?: string
  /** Range checks on result columns ("table.column") or bands ("layer.band") */
  ranges?: RangeRule[]
}

export interface RangeRule {
  target: string
  min?: number
  max?: number
}

// ============================================================================
// Run result (what run(ctx) returns; harness serializes this to stdout)
// ============================================================================

export interface RunResult {
  /** Rows per destination table id */
  data?: Record<string, Record<string, unknown>[]>
  /** Raster artifacts written to /out, to be registered in the catalog */
  rasters?: RasterArtifact[]
  /** Next incremental state, persisted and passed as previousState */
  state?: Record<string, unknown>
}

export interface RasterArtifact {
  layerId: string
  /** Path relative to /out */
  path: string
  /** Observation time or period of this snapshot */
  timestamp: string
  timestampEnd?: string
  /** [west, south, east, north], EPSG:4326; server derives from the file when absent */
  footprint?: [number, number, number, number]
  metadata?: Record<string, unknown>
}
