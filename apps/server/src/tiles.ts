import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { promisify } from "node:util"
import { mkdir, readFile, writeFile, rm, access, readdir, stat, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { BandRendering } from "@data-integrator/definitions"
import { RasterStore } from "./rasterStore.js"

const execFileP = promisify(execFile)

/** Half the web mercator world extent in meters. */
const MERCATOR_EXTENT = 20037508.342789244

/** EPSG:3857 bounds of a slippy tile. */
function tileBounds(z: number, x: number, y: number): [number, number, number, number] {
  const size = (2 * MERCATOR_EXTENT) / 2 ** z
  const minX = -MERCATOR_EXTENT + x * size
  const maxY = MERCATOR_EXTENT - y * size
  return [minX, maxY - size, minX + size, maxY]
}

/** gdaldem color-relief ramp text from a color map; nodata renders transparent. */
function rampText(rendering: BandRendering): string {
  const lines = ["nv 0 0 0 0"]
  for (const stop of rendering.colorMap ?? []) {
    const hex = stop.color.replace("#", "")
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255
    lines.push(`${stop.value} ${r} ${g} ${b} ${a}`)
  }
  return lines.join("\n") + "\n"
}

/**
 * Renders PNG map tiles from stored COGs via the GDAL CLI (warp to the tile's
 * mercator window, color-relief, translate to PNG), caching by snapshot-pinned
 * key so entries never go stale.
 */
export class TileRenderer {
  private store: RasterStore
  private cacheDir: string

  /** Creates a renderer over a raster store with a tile cache directory. */
  constructor(store: RasterStore, cacheDir: string) {
    this.store = store
    this.cacheDir = cacheDir
  }

  /**
   * Returns the PNG for one tile, rendering and caching on miss.
   * @param snapshotPath - Store-relative path of the snapshot COG
   * @param bandId - Band being drawn; part of the cache key, since bands of one
   *   snapshot share a path but render to different pixels
   * @param rendering - Band rendering config (color map, resampling)
   * @param alive - Rendering stops between steps once this returns false
   *   (the requester hung up); the tile resolves to null instead
   */
  async tile(
    layerId: string,
    snapshotId: string,
    snapshotPath: string,
    bandId: string,
    rendering: BandRendering,
    z: number,
    x: number,
    y: number,
    alive: () => boolean = () => true
  ): Promise<Buffer | null> {
    // The rendering config is part of the key: restyling a band must not
    // serve tiles drawn under the old ramp (stale entries age out via the
    // cache budget)
    const style = createHash("sha1").update(JSON.stringify(rendering)).digest("hex").slice(0, 8)
    const cached = path.join(this.cacheDir, layerId, snapshotId, `${bandId}-${style}`, String(z), String(x), `${y}.png`)
    try {
      await access(cached)
      return await readFile(cached)
    } catch {
      // render below
    }

    const [minX, minY, maxX, maxY] = tileBounds(z, x, y)
    const work = path.join(tmpdir(), `tile-${randomUUID().slice(0, 8)}`)
    await mkdir(work, { recursive: true })
    try {
      const ramp = path.join(work, "ramp.txt")
      await writeFile(ramp, rampText(rendering))
      const warped = path.join(work, "warped.tif")
      const colored = path.join(work, "colored.tif")
      const png = path.join(work, "tile.png")
      const resampling = rendering.resampling === "average" ? "average" : "near"
      if (!alive()) return null
      await execFileP("gdalwarp", [
        "-q", "-t_srs", "EPSG:3857",
        "-te", String(minX), String(minY), String(maxX), String(maxY),
        "-ts", "256", "256", "-r", resampling,
        this.store.absolute(snapshotPath), warped
      ])
      if (!alive()) return null
      await execFileP("gdaldem", ["color-relief", "-q", "-alpha", warped, ramp, colored])
      if (!alive()) return null
      await execFileP("gdal_translate", ["-q", "-of", "PNG", colored, png])
      const buffer = await readFile(png)
      await mkdir(path.dirname(cached), { recursive: true })
      await writeFile(cached, buffer)
      return buffer
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }

  /** Removes a layer's whole cache subtree (all snapshots); missing is fine. */
  async dropLayer(layerId: string): Promise<void> {
    await rm(path.join(this.cacheDir, layerId), { recursive: true, force: true })
  }

  /**
   * Evicts oldest-modified cache files until the cache fits the budget.
   * Covers rendered tiles and the proxied basemap alike (both live under the
   * cache directory). Returns how many files were removed.
   */
  async evictToBudget(budgetMb: number): Promise<number> {
    if (budgetMb <= 0) return 0
    const files: { path: string; size: number; mtimeMs: number }[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const target = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(target)
        else if (entry.isFile()) {
          try {
            const info = await stat(target)
            files.push({ path: target, size: info.size, mtimeMs: info.mtimeMs })
          } catch {
            // deleted underneath us; a cache never minds
          }
        }
      }
    }
    await walk(this.cacheDir)

    let total = files.reduce((sum, file) => sum + file.size, 0)
    const budget = budgetMb * 1024 * 1024
    if (total <= budget) return 0
    files.sort((a, b) => a.mtimeMs - b.mtimeMs)
    let evicted = 0
    for (const file of files) {
      if (total <= budget) break
      await unlink(file.path).catch(() => {})
      total -= file.size
      evicted++
    }
    return evicted
  }
}
