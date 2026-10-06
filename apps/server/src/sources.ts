import pg from "pg"
import { ident } from "./destinations.js"
import { LocalizedString } from "@data-integrator/definitions"

/** One data source in the catalog: a destination table or a raster layer. */
export interface DataSource {
  /** Source kind */
  kind: "table" | "raster"
  /** tableId or layerId */
  id: string
  /** Display name, falling back to the id */
  name: LocalizedString
  /** Owning integration id */
  integrationId: string
  /** Owning integration display name */
  integrationName: LocalizedString
  /** Destination description, falling back to the integration's description */
  description: LocalizedString | null
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
    `SELECT t.id, t.integration_id, i.definition->'name' AS integration_name,
            (SELECT d->'name' FROM jsonb_array_elements(i.definition->'destinations') d
             WHERE d->>'tableId' = t.id LIMIT 1) AS name,
            COALESCE(
              (SELECT d->'description' FROM jsonb_array_elements(i.definition->'destinations') d
               WHERE d->>'tableId' = t.id LIMIT 1),
              i.definition->'description'
            ) AS description,
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
      name: row.name ?? { _base: "en", en: row.id },
      integrationId: row.integration_id,
      integrationName: row.integration_name ?? { _base: "en", en: row.integration_id },
      description: row.description,
      rows,
      columns: row.columns,
      snapshots: null,
      updatedAt: row.finished_at ? row.finished_at.toISOString() : null
    })
  }

  const layers = await pool.query(
    `SELECT l.id, l.name, l.integration_id, i.definition->'name' AS integration_name,
            COALESCE(
              (SELECT d->'description' FROM jsonb_array_elements(i.definition->'destinations') d
               WHERE d->>'layerId' = l.id LIMIT 1),
              i.definition->'description'
            ) AS description,
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
      name: row.name ?? { _base: "en", en: row.id },
      integrationId: row.integration_id,
      integrationName: row.integration_name ?? { _base: "en", en: row.integration_id },
      description: row.description,
      rows: null,
      columns: null,
      snapshots: Number(row.snapshots),
      updatedAt: row.latest ? row.latest.toISOString() : null
    })
  }

  return sources.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
}

/** Geometry facts of one managed destination table, for map views. */
export interface TableGeometry {
  /** First declared geometry column; null when the table has none */
  geometryColumn: string | null
  /** [west, south, east, north] of the data, null when empty or no geometry */
  extent: [number, number, number, number] | null
}

/**
 * Reports whether (and where) a destination table carries geometry, plus the
 * data extent for initial map framing. Null for tables the platform does not
 * manage or that do not exist yet.
 */
export async function tableGeometry(pool: pg.Pool, tableId: string): Promise<TableGeometry | null> {
  const managed = await pool.query("SELECT 1 FROM app.data_tables WHERE id = $1", [tableId])
  if (managed.rows.length === 0) return null
  const column = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'data' AND table_name = $1 AND udt_name = 'geometry'
     ORDER BY ordinal_position LIMIT 1`,
    [tableId]
  )
  if (column.rows.length === 0) {
    const exists = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = 'data' AND table_name = $1",
      [tableId]
    )
    return exists.rows.length === 0 ? null : { geometryColumn: null, extent: null }
  }
  const name = column.rows[0].column_name as string
  const extent = await pool.query(
    `SELECT ST_XMin(e) w, ST_YMin(e) s, ST_XMax(e) e2, ST_YMax(e) n
     FROM (SELECT ST_Extent(${ident(name)}) AS e FROM data.${ident(tableId)}) _x WHERE e IS NOT NULL`
  )
  const row = extent.rows[0]
  return {
    geometryColumn: name,
    extent: row ? [row.w, row.s, row.e2, row.n] : null
  }
}
