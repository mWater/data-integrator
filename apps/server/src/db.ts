import pg from "pg"

/** Creates a connection pool from a Postgres URL. */
export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 })
}
