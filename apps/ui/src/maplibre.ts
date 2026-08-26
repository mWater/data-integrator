/**
 * MapLibre 6 locates its web worker with a runtime-computed URL that survives
 * bundling as a bare /assets/maplibre-gl-worker.mjs request, which does not
 * exist in the built app. Point it at a worker chunk Vite actually emits.
 * Import this module before constructing any Map.
 */
import { setWorkerUrl } from "maplibre-gl"
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"

setWorkerUrl(workerUrl)
