import { copyFile, mkdir, rm } from "node:fs/promises"
import path from "node:path"

/**
 * File-backed raster store: COG bytes on a local directory root, addressed by
 * paths relative to it (`<layerId>/<snapshotId>.tif`). S3-compatible backends
 * arrive later behind this same interface.
 */
export class RasterStore {
  /** Absolute root directory of the store */
  readonly root: string

  /** Creates a store over a local root directory. */
  constructor(root: string) {
    this.root = root
  }

  /** Absolute path of a stored file. */
  absolute(relPath: string): string {
    return path.join(this.root, relPath)
  }

  /** Copies a file into the store at relPath, creating directories as needed. */
  async put(srcFile: string, relPath: string): Promise<void> {
    const dest = this.absolute(relPath)
    await mkdir(path.dirname(dest), { recursive: true })
    await copyFile(srcFile, dest)
  }

  /** Removes a stored file; missing files are not an error. */
  async delete(relPath: string): Promise<void> {
    await rm(this.absolute(relPath), { force: true })
  }
}
