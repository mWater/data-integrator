/**
 * The job contract: what the harness inside each runtime image reads from
 * stdin and what it writes to stdout. These types are the seam between the
 * runner and any application driving it, so they live here rather than with
 * a particular application's definition format.
 */

/**
 * Language runtime a job executes in. Names a language only: the image behind
 * it, and the language version inside it, are fixed by RUNTIME_VERSION, so a
 * definition never has to change when the image moves to a newer Node or Python.
 */
export type RuntimeId = "node" | "python"

/** JSON the harness reads from stdin. Every field is optional to the harness; applications decide what they send. */
export interface JobPayload {
  /** "snippet" bypasses the entrypoint and returns raw stdout; absent means a normal run */
  mode?: "snippet"
  /** Application-defined integration definition, exposed as ctx.definition */
  definition?: unknown
  /** Source of the entrypoint module; falls back to definition.code when absent */
  code?: string
  /**
   * Multi-file job: source files by path relative to the code directory
   * (e.g. "flood/daily.py"), so packages and relative imports work. Replaces
   * `code` for the entrypoint; in snippet mode the files are importable from
   * the snippet. Paths are relative, "/"-separated, without "." or ".." segments.
   */
  files?: Record<string, string>
  /** Path in `files` of the entrypoint module; required with `files` outside snippet mode */
  entry?: string
  /** Decrypted secrets by name, exposed as ctx.secrets. Travel here, never in env */
  secrets?: Record<string, string>
  /** State returned by the last successful run; null on the first */
  previousState?: unknown
  /** Webhook deliveries since the last run, oldest first */
  webhookData?: unknown[]
  /** Run parameters, exposed as ctx.params; the Data Integrator passes the definition's resolved settings */
  params?: Record<string, unknown>
  /** What is already published per raster destination, so code can skip work it has done */
  catalog?: Record<string, CatalogLayerState>
}

/** Published state of one raster destination, keyed by layer id in JobPayload.catalog. */
export interface CatalogLayerState {
  /** Most recent promoted snapshots, ascending by timestamp. Applications bound the list, so older history may be absent. */
  snapshots: CatalogSnapshot[]
}

/** One promoted snapshot as the job sees it. */
export interface CatalogSnapshot {
  /** Observation time (or period start), ISO-8601 */
  timestamp: string
  /** Period end when the snapshot covers a range */
  timestampEnd?: string
  /** Application-assigned label, e.g. an ISO date, when the application uses one */
  label?: string
  /** Number of files in the snapshot; 0 is a published "nothing observed" */
  sources: number
}

/** Return value of run(ctx); the harness serializes it to stdout. */
export interface RunResult {
  /** Rows per destination table id, inline. Bounded by the stdout cap; larger tables go in `tables`. */
  data?: Record<string, Record<string, unknown>[]>
  /** Table files written to /out, loaded into their destination tables */
  tables?: TableArtifact[]
  /** Raster artifacts written to /out, to be registered in the catalog */
  rasters?: RasterArtifact[]
  /** Next incremental state, persisted and passed as previousState */
  state?: Record<string, unknown>
}

/**
 * One table file produced by a run, loaded into a destination table. The file
 * channel carries the same rows `data` would, without serializing them through
 * stdout, so it is the way to deliver large or geometry-heavy tables. A tableId
 * may appear in `data` or `tables`, never both.
 */
export interface TableArtifact {
  /** Destination table the file feeds */
  tableId: string
  /** Path relative to /out */
  path: string
  /** File format; server derives it from the extension when absent */
  format?: TableArtifactFormat
}

/** Formats accepted for a table file; all are read with OGR. */
export type TableArtifactFormat = "geojson" | "fgb" | "gpkg" | "csv"

/**
 * One raster snapshot produced by a run. A snapshot is one file (`path`) or a
 * set of files (`sources`) that together cover the observation: tiled
 * products at high resolution over large extents (10-degree flood tiles,
 * per-country population grids) stay as tiles and are mosaicked at read
 * time. Exactly one of `path` or `sources` is given. An empty `sources`
 * array publishes an empty snapshot: nothing was observed, and it supersedes
 * the previous snapshot like any other. Omitting the artifact means no update.
 */
export interface RasterArtifact {
  /** Destination layer the snapshot belongs to */
  layerId: string
  /** Path relative to /out, for a single-file snapshot */
  path?: string
  /** Files making up the snapshot, mosaicked at read time; [] publishes an empty snapshot */
  sources?: RasterSource[]
  /** Observation time (or period start) of this snapshot */
  timestamp: string
  /** Period end when the snapshot covers a range */
  timestampEnd?: string
  /** [west, south, east, north], EPSG:4326, of a single-file snapshot; server derives from the file when absent */
  footprint?: [number, number, number, number]
  /** CRS shared by every file, e.g. "EPSG:4326"; server derives from the files when absent */
  crs?: string
  /** Free-form metadata stored on the snapshot */
  metadata?: Record<string, unknown>
}

/** One file of a multi-file raster snapshot. */
export interface RasterSource {
  /** Path relative to /out */
  path: string
  /** [west, south, east, north], EPSG:4326; server derives from the file when absent */
  footprint?: [number, number, number, number]
}
