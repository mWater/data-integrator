/**
 * Integration definition types: the machine-readable library format.
 *
 * A definition is one file in the versioned integration library. It declares
 * everything about an integration except secret values: source, trigger, AOI,
 * inputs, runtime, limits, destinations, validation rules, and the single
 * self-contained code file implementing the run(ctx) entrypoint.
 *
 * Library definitions are starting values: installing copies them into the
 * integration's own definition, the single specification of the installed
 * integration. Updates from the library carry the deployment-owned fields
 * (aoi, trigger, limits) over. There is no version field; the server assigns
 * integration versions on install.
 *
 * Types only: the server validates definitions (apps/server/src/install.ts).
 * The format is specified in docs/spec/Integration Library Specification.md.
 */

// ============================================================================
// Localization
// ============================================================================

import type { RuntimeId } from "@mwater/integration-runner"
export type { RuntimeId }

/**
 * A human-facing string localized per ez-localize's shape: _base names the
 * locale the text was authored in (always present as a key), other keys carry
 * translations. Structurally identical to ez-localize's LocalizedString, so
 * either type flows into the other.
 */
export interface LocalizedString {
  /** Locale code the string was authored in; that locale is always a key below */
  _base: string
  /** Text per locale code */
  [locale: string]: string
}

/**
 * Release ceiling: the locales this build's UI chrome supports, in picker
 * order. The deployment's `locales` setting is a subset of these; the data
 * translation pass and the language picker both honor the setting, never this
 * list directly.
 */
export const SUPPORTED_LOCALES: { code: string; name: string }[] = [
  { code: "en", name: "English" },
  { code: "fr", name: "Français" },
  { code: "pt", name: "Português" },
  { code: "es", name: "Español" },
  { code: "mg", name: "Malagasy" },
  { code: "sw", name: "Kiswahili" }
]

/**
 * Resolves a localized string for a locale, falling back to the string's own
 * base language (not English - a French-authored, untranslated string renders
 * French everywhere rather than disappearing).
 */
export function localizeString(value: LocalizedString | string | undefined, locale: string): string {
  if (value === undefined) return ""
  if (typeof value === "string") return value
  return value[locale] ?? value[value._base] ?? ""
}

/** Wraps a plain string as a LocalizedString authored in the given locale. */
export function toLocalizedString(text: string, base: string): LocalizedString {
  return { _base: base, [base]: text }
}

// ============================================================================
// Definition
// ============================================================================

/** One integration in the library: source connection, processing code, and destinations. */
export interface IntegrationDefinition {
  /** Published identifier, snake_case (^[a-z][a-z0-9_]{0,62}$). Renaming is creating a new integration. */
  id: string
  /** Human-readable display name */
  name: LocalizedString
  /** What the integration does and any caveats */
  description?: LocalizedString
  /** Provenance of the external source; documentation, not behavior. Absent for derived integrations. */
  source?: SourceInfo
  /** How runs are triggered. Library entries suggest a cadence; the installed value is carried over on library updates. */
  trigger: Trigger
  /** Names of secrets the code reads via ctx.secrets. Values live in the app DB, never here. */
  secrets?: string[]
  /**
   * Area of interest clipping ingestion and input extracts. Tri-state: an
   * explicit Aoi clips to it; explicit null means the source's full extent;
   * omitted inherits the deployment default at run time. Changing it is a
   * definition edit and creates a new integration version.
   */
  aoi?: Aoi | null
  /** Platform data materialized read-only at /in, keyed by input id */
  inputs?: Record<string, InputRef>
  /** Uploaded files the code reads at /in/files/<slotId><ext>, keyed by slot id; the deployment holds the contents */
  files?: Record<string, FileSlotSpec>
  /** Runtime image the code runs in */
  runtime: RuntimeId
  /** Resource limits for each run. Library entries suggest limits; the installed value is carried over on library updates. */
  limits?: JobLimitsSpec
  /** Tables and raster layers the integration writes to */
  destinations: Destination[]
  /** Data-quality rules evaluated on each run's results; violations flag the run */
  validation?: ValidationSpec
  /**
   * Settings operators may change without editing code, keyed by setting id.
   * Job code reads the resolved values from ctx.params, and nothing else
   * reaches ctx.params.
   */
  settings?: Record<string, SettingSpec>
  /**
   * This deployment's values for declared settings, keyed by setting id;
   * absent ids take the declared default. Changing one is a definition edit
   * and creates a new integration version. Carried over on library updates.
   */
  settingValues?: Record<string, SettingValue>
  /** Single self-contained file implementing the entrypoint */
  code: string
  /** Entrypoint contract version */
  contract: 2
}


/** A value of a declared setting: integer, boolean, or the text of a choice or text setting. */
export type SettingValue = number | boolean | string

/** One operator-facing setting the integration's code reads from ctx.params. */
export interface SettingSpec {
  /** Short label shown on the form */
  label: LocalizedString
  /** What the setting changes, and when it takes effect, shown beside the control */
  description?: LocalizedString
  /** integer (with optional bounds), boolean, choice (one of choices), or text (optionally matching pattern) */
  type: "integer" | "boolean" | "choice" | "text"
  /** Value when the deployment has not set one; must itself be valid */
  default: SettingValue
  /** Smallest allowed integer */
  min?: number
  /** Largest allowed integer */
  max?: number
  /** Allowed values of a choice setting, in display order */
  choices?: SettingChoice[]
  /** Regular expression a text value must match in full */
  pattern?: string
  /**
   * "rebuild" when the code reads the setting only when it starts from no
   * previous state (backfill depth, history to fetch), so a change shows on
   * the next rebuild; "every-run" (the default) otherwise.
   */
  appliesOn?: "every-run" | "rebuild"
}

/** One allowed value of a choice setting. */
export interface SettingChoice {
  /** Value the code receives */
  value: string
  /** Label shown on the form */
  label: LocalizedString
}

/** Provenance of the external data source, for documentation and lineage. */
export interface SourceInfo {
  /** Source name, e.g. "GloFAS river discharge" */
  name: LocalizedString
  /** Primary URL of the source or its API */
  url?: string
  /** Organization publishing the data */
  provider?: string
  /** License of the source data, e.g. "CC-BY-4.0" */
  license?: string
  /** Link to source documentation */
  documentation?: string
  /** Known caveats a data consumer should see: accuracy, coverage, timeliness, interpretation pitfalls */
  limitations?: LocalizedString
}

/** How runs of the integration are triggered. */
export interface Trigger {
  /** cron expression, UTC */
  cron?: string
  /** Accept webhook payloads, buffered and batched into ctx.webhookData (all pending events, oldest first) */
  webhook?: boolean
  /** Batch window in seconds: the first event schedules the run this far out and later events join it (default 0: immediate) */
  webhookDelaySeconds?: number
}

/** Area of interest that ingestion and input extracts are clipped to. */
export interface Aoi {
  /** [west, south, east, north], EPSG:4326; west > east crosses the antimeridian */
  bbox: [number, number, number, number]
  /** ISO 3166-1 alpha-3 codes covered by the box; a hint for sources keyed by country rather than extent */
  countries?: string[]
}

/** Per-run resource requests; the deployment lowers each to its configured maximum. */
export interface JobLimitsSpec {
  /** CPU cores */
  cpus?: number
  /** Memory ceiling in MB */
  memoryMb?: number
  /** Wall-clock timeout in ms */
  timeoutMs?: number
  /** Quota for the persistent /work workspace in MB, polled during the run (the job is killed past it) */
  workDiskMb?: number
  /** Quota for the run's /tmp in MB, temporary disk removed after the run, polled during the run (the job is killed past it) */
  tmpDiskMb?: number
}

// ============================================================================
// Inputs (materialized at /in; see docs/Architecture.md)
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
   * Extract file format. Default by runtime: gpkg for python, json for node.
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
// File slots (uploaded files; see docs/Integration Files.md)
// ============================================================================

/**
 * One file the integration reads, uploaded by users and versioned by the
 * deployment. The definition names the slot; each upload is a new version,
 * and a run reads the version it pins or the slot's current one.
 */
export interface FileSlotSpec {
  /** What the file is and what it must contain, shown beside the upload control */
  description?: LocalizedString
  /** Accepted extensions, lowercase with the dot (e.g. [".xlsx", ".xls"]); absent accepts any */
  accept?: string[]
}

// ============================================================================
// Input manifest (what the server materialized at /in)
// ============================================================================

/**
 * Contents of /in/manifest.json, written by the server at job launch when the
 * definition declares inputs or files. Authoritative about paths; conventionally
 * rasters land as /in/<inputId>/<timestamp>.tif, table extracts as
 * /in/<inputId>.<ext>, and file versions as /in/files/<slotId><ext>.
 */
export interface InManifest {
  /** Materialized inputs keyed by input id, matching definition.inputs */
  inputs: Record<string, InManifestInput>
  /** Materialized file versions keyed by slot id; absent when the run reads no files */
  files?: Record<string, InManifestFile>
}

/** One file version as materialized for a run, also recorded on the run for lineage. */
export interface InManifestFile {
  /** Path relative to /in: files/<slotId><ext> */
  path: string
  /** File version id */
  versionId: string
  /** Version number within the slot (1, 2, ...) */
  version: number
  /** Name the file was uploaded under; display only */
  filename: string
  /** SHA-256 of the contents, hex */
  sha256: string
  /** Size in bytes */
  sizeBytes: number
  /** Upload time (ISO) */
  uploadedAt: string
}

/** One materialized input: raster snapshots or a table extract. */
export type InManifestInput = RasterInManifestInput | TableInManifestInput

/** Raster input as materialized: one openable path per selected snapshot. */
export interface RasterInManifestInput {
  /** Discriminator */
  kind: "raster"
  /** Catalog layer the snapshots came from */
  layerId: string
  /** Materialized snapshots, ascending by timestamp */
  snapshots: InManifestSnapshot[]
}

/**
 * One materialized catalog snapshot. Single-file snapshots are the COG
 * itself; multi-file snapshots are a VRT over their files, which GDAL and
 * rasterio open like any raster; empty snapshots have no path.
 */
export interface InManifestSnapshot {
  /** Path relative to /in; null for an empty snapshot */
  path: string | null
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

/** Tabular destination; rows arrive via RunResult.data keyed by tableId, or as a file via RunResult.tables. */
export interface TableDestination {
  /** Discriminator */
  kind: "table"
  /** Destination table, created/managed by the server; snake_case, becomes the table name in the data schema */
  tableId: string
  /** Human-readable display name */
  name?: LocalizedString
  /** How incoming rows are applied */
  action: "replace" | "append" | "merge"
  /** Key columns identifying a row; required when action is "merge" */
  mergeColumns?: string[]
  /** One-sentence summary of what the table contains, shown in the data catalog */
  description?: LocalizedString
  /** Schema of the destination table */
  columns: ColumnSpec[]
}

/** One column of a destination table. */
export interface ColumnSpec {
  /** Column id, lowercase snake case */
  id: string
  /** Human-readable display name */
  name?: LocalizedString
  /** Value type of the column; integer is exact (bigint), number is floating point */
  type: "text" | "number" | "integer" | "boolean" | "date" | "datetime" | "geometry" | "enum" | "json"
  /** Permitted codes when type is "enum": the harmonization target for source codings. Stored as text; out-of-vocabulary values flag the run. */
  enumValues?: { id: string; name: LocalizedString }[]
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
  name?: LocalizedString
  /** One-sentence summary of what the layer shows, shown in the data catalog */
  description?: LocalizedString
  /** time-series retains promoted snapshots as history; current-only prunes superseded */
  temporality: "time-series" | "current-only"
  /** How much history a time-series layer keeps; absent keeps every snapshot */
  retention?: RasterRetention
  /** Bands of the layer */
  bands: BandSpec[]
}

/** History window of a time-series raster layer. */
export interface RasterRetention {
  /** Snapshots whose observation ended more than this many days ago are deleted (the current snapshot is always kept) */
  days: number
}

/** One band of a raster layer. */
export interface BandSpec {
  /** Band id, stable key used in tile and query URLs */
  id: string
  /** Human-readable display name */
  name?: LocalizedString
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
  /** Overview resampling; nearest avoids inflating sparse data */
  resampling?: "nearest" | "average"
}

// ============================================================================
// Validation rules
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
// Run result: the job contract lives with the runner, re-exported here
// ============================================================================

export type {
  RasterArtifact,
  RasterSource,
  RunResult,
  TableArtifact,
  TableArtifactFormat
} from "@mwater/integration-runner"
