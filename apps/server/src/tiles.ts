import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { promisify } from "node:util"
import { mkdir, readFile, writeFile, rename, rm, access, readdir, stat, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { BandRendering } from "@data-integrator/definitions"
import { RasterStore } from "./rasterStore.js"
import { SourceRef } from "./catalog.js"

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

/** WGS84 [west, south, east, north] of a slippy tile. */
function tileBbox(z: number, x: number, y: number): [number, number, number, number] {
  const n = 2 ** z
  const lat = (ty: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI
  return [(x / n) * 360 - 180, lat(y + 1), ((x + 1) / n) * 360 - 180, lat(y)]
}

/** Whether two [w, s, e, n] boxes overlap. */
function overlaps(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
}

/** A fully transparent PNG, served for tiles no source covers. */
const EMPTY_TILE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
  "base64"
)

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

/** Concurrent cache-miss renders when the caller sets no limit. */
export const DEFAULT_RENDER_CONCURRENCY = 3

/**
 * Environment for the GDAL tile subprocesses. A 256x256 tile needs a small
 * block cache; GDAL's default (5% of RAM per process) multiplied by
 * concurrent renders is enough to exhaust a small host.
 */
const GDAL_ENV = { ...process.env, GDAL_CACHEMAX: "64" }

/** Tunables for a tile renderer. */
export interface TileRendererOptions {
  /** Cache-miss renders allowed at once; further requests queue (default 3) */
  maxConcurrentRenders?: number
}

/**
 * Renders PNG map tiles from stored COGs via the GDAL CLI (warp to the tile's
 * mercator window, color-relief, translate to PNG), caching by snapshot-pinned
 * key so entries never go stale. A map view fans out dozens of tile requests
 * at once and each render forks GDAL processes worth hundreds of MB, so
 * misses pass through a fixed-size gate; cache hits never wait.
 */
export class TileRenderer {
  private store: RasterStore
  private cacheDir: string
  private maxConcurrentRenders: number
  private activeRenders = 0
  private waiters: (() => void)[] = []

  /** Creates a renderer over a raster store with a tile cache directory. */
  constructor(store: RasterStore, cacheDir: string, options: TileRendererOptions = {}) {
    this.store = store
    this.cacheDir = cacheDir
    this.maxConcurrentRenders = Math.max(1, options.maxConcurrentRenders ?? DEFAULT_RENDER_CONCURRENCY)
  }

  /** Renders in progress right now (queued requests are not counted). */
  get rendering(): number {
    return this.activeRenders
  }

  /** Waits for a render slot; resolves once one is held. */
  private acquire(): Promise<void> {
    if (this.activeRenders < this.maxConcurrentRenders) {
      this.activeRenders++
      return Promise.resolve()
    }
    return new Promise(resolve => {
      this.waiters.push(() => {
        this.activeRenders++
        resolve()
      })
    })
  }

  /** Releases a render slot to the next queued request, if any. */
  private release(): void {
    this.activeRenders--
    this.waiters.shift()?.()
  }

  /** The tile's cached PNG, or null when not cached yet. */
  private async fromCache(cached: string): Promise<Buffer | null> {
    try {
      await access(cached)
      return await readFile(cached)
    } catch {
      return null
    }
  }

  /**
   * Returns the PNG for one tile, rendering and caching on miss. Sources
   * not touching the tile are skipped; several touching it are mosaicked
   * through a VRT; none touching it is a transparent tile.
   * @param sources - The snapshot's files with their footprints
   * @param bandId - Band being drawn; part of the cache key, since bands of one
   *   snapshot share files but render to different pixels
   * @param rendering - Band rendering config (color map, resampling)
   * @param alive - Rendering stops between steps once this returns false
   *   (the requester hung up); the tile resolves to null instead
   * @param mask - Shape to clip the drawing to, as a short key naming it in
   *   the cache and a loader for its GeoJSON (WGS84), called once per key
   *   and then read from disk; null draws everything the files cover
   */
  async tile(
    layerId: string,
    snapshotId: string,
    sources: SourceRef[],
    bandId: string,
    rendering: BandRendering,
    z: number,
    x: number,
    y: number,
    alive: () => boolean = () => true,
    mask: { key: string; geojson: () => Promise<string> } | null = null
  ): Promise<Buffer | null> {
    // The rendering config and the mask are part of the key: restyling a band
    // or reshaping the area must not serve tiles drawn under the old ramp or
    // cut (stale entries age out via the cache budget)
    const style = createHash("sha1").update(JSON.stringify(rendering)).digest("hex").slice(0, 8)
    const variant = mask ? `${bandId}-${style}-m${mask.key}` : `${bandId}-${style}`
    const cached = path.join(this.cacheDir, layerId, snapshotId, variant, String(z), String(x), `${y}.png`)
    const hit = await this.fromCache(cached)
    if (hit) return hit

    const bbox = tileBbox(z, x, y)
    const touching = sources.filter(source => overlaps(source.bbox, bbox))
    if (touching.length === 0) return EMPTY_TILE

    await this.acquire()
    try {
      // Queued behind other renders: the requester may have hung up, or a
      // twin request may have rendered this very tile meanwhile
      if (!alive()) return null
      const rendered = await this.fromCache(cached)
      if (rendered) return rendered
      return await this.render(touching, rendering, z, x, y, alive, mask, cached)
    } finally {
      this.release()
    }
  }

  /** Runs the GDAL pipeline for one tile and writes it to the cache path. */
  private async render(
    touching: SourceRef[],
    rendering: BandRendering,
    z: number,
    x: number,
    y: number,
    alive: () => boolean,
    mask: { key: string; geojson: () => Promise<string> } | null,
    cached: string
  ): Promise<Buffer | null> {
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
      let input = this.store.absolute(touching[0].path)
      if (touching.length > 1) {
        input = path.join(work, "mosaic.vrt")
        await execFileP("gdalbuildvrt", ["-q", input, ...touching.map(source => this.store.absolute(source.path))], {
          env: GDAL_ENV
        })
      }
      await execFileP("gdalwarp", [
        "-q", "-t_srs", "EPSG:3857",
        "-te", String(minX), String(minY), String(maxX), String(maxY),
        "-ts", "256", "256", "-r", resampling,
        input, warped
      ], { env: GDAL_ENV })
      if (!alive()) return null
      await execFileP("gdaldem", ["color-relief", "-q", "-alpha", warped, ramp, colored], { env: GDAL_ENV })
      if (!alive()) return null
      let final = colored
      if (mask) {
        // Cut the colored RGBA tile, not the data: outside pixels become 0 in
        // every band including alpha, so the cut is transparent whatever the
        // source's nodata. ALL_TOUCHED keeps coastal cells that the boundary
        // crosses, so a coarse grid still reads as coarse along the coast
        const cutline = await this.cutline(mask, work)
        final = path.join(work, "masked.tif")
        await execFileP("gdalwarp", [
          "-q", "-cutline", cutline, "-wo", "CUTLINE_ALL_TOUCHED=TRUE", "-dstnodata", "0",
          colored, final
        ], { env: GDAL_ENV })
        if (!alive()) return null
      }
      await execFileP("gdal_translate", ["-q", "-of", "PNG", final, png], { env: GDAL_ENV })
      const buffer = await readFile(png)
      await mkdir(path.dirname(cached), { recursive: true })
      await writeFile(cached, buffer)
      return buffer
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }

  /**
   * Path of the mask's GeoJSON on disk, fetched and written on the first
   * tile that needs it: a country outline runs to megabytes and must not
   * travel from the database for every cache miss. Written under a temporary
   * name in the work directory and moved into place so a concurrent miss
   * never reads a half-written file.
   */
  private async cutline(mask: { key: string; geojson: () => Promise<string> }, work: string): Promise<string> {
    const file = path.join(this.cacheDir, "masks", `${mask.key}.geojson`)
    try {
      await access(file)
      return file
    } catch {
      // fetch below
    }
    const staging = path.join(work, "mask.geojson")
    await writeFile(staging, await mask.geojson())
    await mkdir(path.dirname(file), { recursive: true })
    await rename(staging, file)
    return file
  }

  /**
   * Reads one pixel of a snapshot at a WGS84 lon/lat, from the first of its
   * files covering the point that yields a value. Null when no file covers
   * the point, none can be read, or the value is not a finite number.
   */
  async sample(sources: SourceRef[], bandIndex: number, lon: number, lat: number): Promise<number | null> {
    for (const source of sources) {
      if (!overlaps(source.bbox, [lon, lat, lon, lat])) continue
      try {
        const { stdout } = await execFileP(
          "gdallocationinfo",
          ["-valonly", "-wgs84", "-b", String(bandIndex), this.store.absolute(source.path), String(lon), String(lat)],
          { timeout: 15_000 }
        )
        const value = Number(stdout.trim())
        if (Number.isFinite(value)) return value
      } catch {
        // unreadable or outside this file; try the next
      }
    }
    return null
  }

  /** Removes one snapshot's cached tiles; missing is fine. */
  async dropSnapshot(layerId: string, snapshotId: string): Promise<void> {
    await rm(path.join(this.cacheDir, layerId, snapshotId), { recursive: true, force: true })
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
