/** Tool-call input contracts for assistant blocks (mirrors the server's zod schemas). */

/** Input of show_chart: the kit Chart declarative subset bound to a result. */
export interface ShowChartInput {
  /** Stored result the chart binds to */
  resultId: string
  /** Title above the chart */
  title: string
  /** Chart form */
  type: "line" | "area" | "bar" | "pie" | "scatter"
  /** Column for the x axis (slice label for pie) */
  x: string
  /** Value columns plotted as series */
  series: string[]
  /** Display label per series column */
  labels?: Record<string, string>
  /** Stack bar/area series */
  stacked?: boolean
  /** X-axis scale */
  xType?: "category" | "time"
}

/** One catalog raster layer drawn by show_map. */
export interface ShowMapLayer {
  /** Raster layer id */
  layerId: string
  /** YYYY-MM-DD; draws the snapshot covering this date (default: current) */
  at?: string
  /** Legend title */
  label?: string
  /** Raster opacity */
  opacity?: number
}

/** One overlay drawn by show_map from a stored result's rows. */
export interface ShowMapOverlay {
  /** Stored result holding the feature rows */
  resultId: string
  /** Column holding ST_AsGeoJSON output */
  geojsonColumn?: string
  /** Longitude number column (pair with latColumn) */
  lonColumn?: string
  /** Latitude number column */
  latColumn?: string
  /** Legend title */
  label?: string
  /** Overlay color */
  color?: string
  /** Column shown on feature click */
  popup?: string
}

/** Input of show_map. */
export interface ShowMapInput {
  /** Title above the map */
  title?: string
  /** Catalog raster layers, bottom to top */
  layers?: ShowMapLayer[]
  /** GeoJSON overlays from query rows */
  overlays?: ShowMapOverlay[]
  /** Fit viewport to overlay data */
  fit?: boolean
}

/** Result id a successful query tool-result text announces on its first line. */
export function parseResultId(resultText: string | undefined): string | null {
  const match = /^result_id: (q\d+)/.exec(resultText ?? "")
  return match ? match[1] : null
}

/**
 * Whether a tool call renders as a result block. Failed or cancelled calls
 * degrade to the ordinary collapsed activity row.
 */
export function isBlockCall(tool: string | undefined, resultText: string | undefined): boolean {
  if (tool === "query") return parseResultId(resultText) != null
  if (tool === "show_chart" || tool === "show_map") {
    return resultText != null && !resultText.startsWith("Error:") && !resultText.startsWith("Cancelled:")
  }
  return false
}
