import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import pg from "pg"

const execFileP = promisify(execFile)

/** PostGIS image used for ephemeral test databases. */
export const POSTGIS_IMAGE = "docker.io/postgis/postgis:16-3.4"

/** A running test database and how to dispose of it. */
export interface TestDb {
  /** Connection URL */
  url: string
  /** Stops and removes the container and its data volume (no-op for TEST_DATABASE_URL) */
  stop: () => Promise<void>
}

/**
 * Provides a Postgres+PostGIS database for tests: TEST_DATABASE_URL if set,
 * otherwise an ephemeral podman container on a random local port.
 */
export async function startTestDb(): Promise<TestDb> {
  const external = process.env.TEST_DATABASE_URL
  if (external) {
    return { url: external, stop: async () => {} }
  }

  const name = `pgtest-${randomUUID().slice(0, 8)}`
  await execFileP("podman", [
    "run", "-d", "--rm", "--name", name,
    "-e", "POSTGRES_PASSWORD=test",
    "-p", "127.0.0.1::5432",
    // Same-path mount of the host tmpdir: out-db raster registration hands
    // the database absolute paths of test raster stores created under it
    "-v", `${tmpdir()}:${tmpdir()}`,
    POSTGIS_IMAGE
  ])
  const { stdout } = await execFileP("podman", ["port", name, "5432"])
  const port = stdout.trim().split(":").pop()
  const url = `postgres://postgres:test@127.0.0.1:${port}/postgres`

  // Postgres restarts once during initdb; wait until a real query succeeds
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      const client = new pg.Client({ connectionString: url })
      await client.connect()
      await client.query("SELECT 1")
      await client.end()
      break
    } catch {
      if (Date.now() > deadline) {
        await execFileP("podman", ["rm", "-f", "-v", name]).catch(() => {})
        throw new Error("Test Postgres did not become ready in 60s")
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }

  return {
    url,
    stop: async () => {
      await execFileP("podman", ["rm", "-f", "-v", name]).catch(() => {})
    }
  }
}
