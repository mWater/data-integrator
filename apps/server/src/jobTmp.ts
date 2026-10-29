import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises"
import path from "node:path"

/**
 * Per-job /tmp directories. Each job (run or snippet) gets an empty directory
 * on disk mounted at /tmp, removed when the job ends, so downloads and
 * intermediates neither persist in /work nor count against job memory. They
 * live under the work root so the free-space floor on it covers them; the
 * leading dot keeps them apart from integration and session workspaces.
 */

/** Directory under the work root holding running jobs' /tmp directories. */
export const JOB_TMP_DIR = ".tmp"

/** Age after which a leftover /tmp directory (from a crashed process) is removed. */
const LEFTOVER_MS = 2 * 24 * 3600_000

/** Creates an empty /tmp directory for one job; the caller removes it when the job ends. */
export async function createJobTmp(workRoot: string, prefix: "run" | "snippet"): Promise<string> {
  const root = path.join(workRoot, JOB_TMP_DIR)
  await mkdir(root, { recursive: true })
  return mkdtemp(path.join(root, `${prefix}-`))
}

/**
 * Removes /tmp directories left by a process that died mid-job: older than any
 * job could run. Returns how many were removed.
 */
export async function sweepJobTmp(workRoot: string): Promise<number> {
  const root = path.join(workRoot, JOB_TMP_DIR)
  const entries = await readdir(root).catch(() => [] as string[])
  let removed = 0
  for (const entry of entries) {
    const full = path.join(root, entry)
    const info = await stat(full).catch(() => null)
    if (info && Date.now() - info.mtimeMs > LEFTOVER_MS) {
      await rm(full, { recursive: true, force: true })
      removed++
    }
  }
  return removed
}
