import { chmod, copyFile, mkdir, rm } from "node:fs/promises"
import path from "node:path"

/**
 * File-backed raster store: COG bytes on a local directory root, addressed by
 * paths relative to it (`<layerId>/<snapshotId>/<ordinal>.tif`). Postgres
 * reads the same files for out-db SQL, so the store must be a filesystem the
 * database server can see.
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

  /**
   * Copies a file into the store at relPath, creating directories as needed.
   * Contents are made world-readable: the Postgres server process reads store
   * files as its own OS user for out-db SQL registration.
   */
  async put(srcFile: string, relPath: string): Promise<void> {
    const dest = this.absolute(relPath)
    await mkdir(path.dirname(dest), { recursive: true })
    await chmod(path.dirname(dest), 0o755)
    await copyFile(srcFile, dest)
    await chmod(dest, 0o644)
  }

  /** Removes a stored file; missing files are not an error. */
  async delete(relPath: string): Promise<void> {
    await rm(this.absolute(relPath), { force: true })
  }
}
