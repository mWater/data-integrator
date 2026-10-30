/**
 * @kit/ui — the dashboard-facing surface. This module (bundled as kit.js) and
 * react are the only imports dashboard source may use; the build enforces it.
 */

export type { Row, DashboardMeta, LayerInfo, LayerSnapshotInfo } from "./bridge.js"
export { lightTheme, darkTheme, seriesColor } from "./theme.js"
export type { ThemeTokens, StatusColors, DivergingPair } from "./theme.js"
export { useQuery, useMeta, useLayers, useTheme, useLocale } from "./hooks.js"
export type { QueryResult } from "./hooks.js"
export { mountDashboard } from "./mount.js"
export type { DashboardProps } from "./mount.js"
export { Page, Grid, Card } from "./components/layout.js"
export type { PageProps, GridProps, CardProps } from "./components/layout.js"
export { StatTile } from "./components/StatTile.js"
export type { StatTileProps } from "./components/StatTile.js"
export { Chart } from "./components/Chart.js"
export type { ChartProps } from "./components/Chart.js"
export { EChart } from "./components/EChart.js"
export type { EChartProps } from "./components/EChart.js"
export { KitTheme } from "./KitTheme.js"
export type { KitThemeProps } from "./KitTheme.js"
export { DataTable } from "./components/DataTable.js"
export type { DataTableProps, TableColumn } from "./components/DataTable.js"
export { FilterBar, Select, MultiSelect, DateRange } from "./components/FilterBar.js"
export type {
  FilterBarProps,
  SelectProps,
  SelectOption,
  MultiSelectProps,
  DateRangeProps
} from "./components/FilterBar.js"
export { KIT_VERSION } from "./version.js"
export { MarkdownBlock } from "./components/MarkdownBlock.js"
export type { MarkdownBlockProps } from "./components/MarkdownBlock.js"
export { MapView } from "./components/MapView.js"
export type {
  MapViewProps,
  MapLayer,
  RasterLegendStop,
  VectorTileLayer,
  ColorScale,
  CategoricalColorScale,
  RampColorScale,
  RadiusScale,
  GeoJsonOverlay,
  GeoJsonFeatureCollection,
  GeoJsonFeature,
  GeoJsonGeometry,
  MapFeatureClick,
  LngLat
} from "./components/MapView.js"
