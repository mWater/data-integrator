import pg from "pg"

/** One data source in the catalog: a destination table or a raster layer. */
export interface DataSource {
  /** Source kind */
  kind: "table" | "raster"
  /** tableId or layerId */
  id: string
  /** Display name (layers have one; tables use their id) */
  name: string
  /** Owning integration id */
  integrationId: string
  /** Owning integration display name */
  integrationName: string
  /** Row count (tables); null before first run */
  rows: number | null
  /** Declared column count (tables) */
  columns: number | null
  /** Promoted snapshot count (rasters) */
  snapshots: number | null
  /** Latest data time (ISO): last successful load for tables, newest observation for rasters */
  updatedAt: string | null
}

/**
 * Lists the data catalog: every destination table and raster layer of the
 * installed integrations (scratch previews excluded), freshest first.
 */
export async function listSources(pool: pg.Pool): Promise<DataSource[]> {
  const tables = await pool.query(
    `SELECT t.id, t.integration_id, i.definition->>'name' AS integration_name,
            COALESCE(jsonb_array_length(t.spec->'columns'), 0) AS columns,
            r.finished_at, to_regclass('data.' || quote_ident(t.id)) IS NOT NULL AS exists
     FROM app.data_tables t
     JOIN app.integrations i ON i.id = t.integration_id
     LEFT JOIN LATERAL (
       SELECT finished_at FROM app.runs
       WHERE integration_id = t.integration_id AND status = 'succeeded'
       ORDER BY finished_at DESC LIMIT 1
     ) r ON true`
  )
  const sources: DataSource[] = []
  for (const row of tables.rows) {
    let rows: number | null = null
    if (row.exists) {
      const count = await pool.query(`SELECT count(*) AS n FROM data."${String(row.id).replace(/"/g, "")}"`)
      rows = Number(count.rows[0].n)
    }
    sources.push({
      kind: "table",
      id: row.id,
      name: row.id,
      integrationId: row.integration_id,
      integrationName: row.integration_name ?? row.integration_id,
      rows,
      columns: row.columns,
      snapshots: null,
      updatedAt: row.finished_at ? row.finished_at.toISOString() : null
    })
  }

  const layers = await pool.query(
    `SELECT l.id, l.name, l.integration_id, i.definition->>'name' AS integration_name,
            (SELECT count(*) FROM app.raster_snapshots s WHERE s.layer_id = l.id AND s.status = 'promoted') AS snapshots,
            (SELECT max(observed_at) FROM app.raster_snapshots s WHERE s.layer_id = l.id AND s.status = 'promoted') AS latest
     FROM app.raster_layers l
     JOIN app.integrations i ON i.id = l.integration_id
     WHERE l.session_id IS NULL`
  )
  for (const row of layers.rows) {
    sources.push({
      kind: "raster",
      id: row.id,
      name: row.name ?? row.id,
      integrationId: row.integration_id,
      integrationName: row.integration_name ?? row.integration_id,
      rows: null,
      columns: null,
      snapshots: Number(row.snapshots),
      updatedAt: row.latest ? row.latest.toISOString() : null
    })
  }

  return sources.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
}
