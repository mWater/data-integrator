/**
 * Caching proxy for basemap resources (style, sprites, glyphs, tiles). The
 * sandboxed dashboard frame cannot reach the internet, so the host fetches
 * through this endpoint; responses are cached on disk and served stale when
 * the upstream is unreachable, so previously-viewed areas keep working
 * offline. JSON responses have upstream URLs rewritten to the di-basemap://
 * scheme the frame's MapLibre protocol handler resolves back through here.
 */

import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { AppConfig } from "./config.js"

/** Basemap proxy configuration: config.basemap plus the cache location. */
export interface BasemapConfig {
  /** Upstream base URL without trailing slash, or null when disabled. */
  upstream: string | null
  /** Upstream path of the light-mode style. */
  styleLight: string
  /** Upstream path of the dark-mode style. */
  styleDark: string
  /** Directory for the on-disk response cache. */
  cacheDir: string
}

/** One proxied response. */
export interface BasemapResponse {
  /** Response body (post-rewrite for JSON). */
  body: Buffer
  /** Content type to serve. */
  contentType: string
}

/** Cache freshness: styles may change upstream, so revalidate daily. */
const FRESH_MS = 24 * 3600 * 1000

/** Upstream fetch timeout. */
const FETCH_TIMEOUT_MS = 10_000

/** Basemap configuration from the central AppConfig. */
export function basemapConfigFrom(config: AppConfig): BasemapConfig {
  return { ...config.basemap, cacheDir: path.join(config.tileCachePath, "basemap") }
}

interface CacheMeta {
  /** Content type of the cached body. */
  contentType: string
  /** Epoch ms when the entry was written. */
  cachedAt: number
}

/** Serves basemap resources from cache or upstream. */
export class BasemapProxy {
  constructor(private readonly config: BasemapConfig) {}

  /** True when a basemap upstream is configured. */
  get enabled(): boolean {
    return this.config.upstream !== null
  }

  /**
   * Fetches one basemap resource by frame-relative path. Returns null when
   * disabled, the path is invalid, or the resource is unavailable both
   * upstream and in cache.
   */
  async fetch(framePath: string): Promise<BasemapResponse | null> {
    const upstream = this.config.upstream
    if (!upstream) return null
    const resolved = this.resolvePath(framePath)
    if (!resolved) return null

    const key = createHash("sha256").update(resolved).digest("hex")
    const bodyFile = path.join(this.config.cacheDir, key)
    const metaFile = bodyFile + ".json"
    const cached = await this.readCache(bodyFile, metaFile)
    if (cached && Date.now() - cached.meta.cachedAt < FRESH_MS) {
      return { body: cached.body, contentType: cached.meta.contentType }
    }

    try {
      const res = await globalThis.fetch(`${upstream}/${resolved}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
      if (!res.ok) throw new Error(`upstream ${res.status}`)
      const contentType = res.headers.get("content-type") ?? "application/octet-stream"
      let body = Buffer.from(await res.arrayBuffer())
      // Frame requests come back through this proxy: point every upstream URL
      // in JSON (styles, TileJSON) at the di-basemap:// protocol instead
      if (contentType.includes("json")) {
        body = Buffer.from(body.toString("utf8").replaceAll(`${upstream}/`, "di-basemap://"), "utf8")
      }
      await this.writeCache(bodyFile, metaFile, body, contentType)
      return { body, contentType }
    } catch {
      // Offline or upstream failure: stale cache beats no map
      if (cached) return { body: cached.body, contentType: cached.meta.contentType }
      return null
    }
  }

  /** Maps the frame path to an upstream path; null when malformed. */
  private resolvePath(framePath: string): string | null {
    if (framePath === "style/light") return this.config.styleLight
    if (framePath === "style/dark") return this.config.styleDark
    if (framePath.includes("..") || framePath.startsWith("/") || framePath.includes("\\")) return null
    if (!/^[\w .\-~@{}/%]+$/.test(framePath)) return null
    return framePath
  }

  private async readCache(
    bodyFile: string,
    metaFile: string
  ): Promise<{ body: Buffer; meta: CacheMeta } | null> {
    try {
      const [body, metaRaw] = await Promise.all([readFile(bodyFile), readFile(metaFile, "utf8")])
      return { body, meta: JSON.parse(metaRaw) as CacheMeta }
    } catch {
      return null
    }
  }

  private async writeCache(
    bodyFile: string,
    metaFile: string,
    body: Buffer,
    contentType: string
  ): Promise<void> {
    try {
      await mkdir(this.config.cacheDir, { recursive: true })
      const meta: CacheMeta = { contentType, cachedAt: Date.now() }
      await writeFile(bodyFile, body)
      await writeFile(metaFile, JSON.stringify(meta))
    } catch {
      // Cache write failure is not a serve failure
    }
  }
}
