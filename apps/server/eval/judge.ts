import { generateText, LanguageModel, stepCountIs, tool } from "ai"
import pg from "pg"
import { z } from "zod"
import { DesignPrompt } from "./prompts.js"

/** Verdict on one acceptance check. */
export interface CheckVerdict {
  /** The check, as written in the prompt file */
  check: string
  /** pass, fail, or unverified (could not be decided from the data) */
  verdict: "pass" | "fail" | "unverified"
  /** Queries and values the verdict rests on */
  evidence: string
}

/** The judge's result for one finished session. */
export interface JudgeResult {
  /** Per-check verdicts */
  checks: CheckVerdict[]
  /** pass when every check passed; fail when any failed; partial otherwise */
  overall: "pass" | "fail" | "partial"
  /** Anything else a reviewer should know */
  notes: string
  /** Tokens the judge used (not charged to the candidate) */
  tokens: number
}

const SYSTEM = `You review a data integration an AI agent built, against the acceptance checks
its request came with. You are skeptical: a check passes only when a query
result or the definition shows it holds. When the data cannot show it (e.g. it
needs a visual check you cannot do), mark it unverified, not pass.

You have read-only SQL on the deployment database (PostgreSQL + PostGIS):
- app.integrations(id, definition jsonb, status): the installed definition.
- app.runs(integration_id, status, stats, error, log): runs; the production
  load is the one with session_id IS NULL.
- app.raster_layers(id, integration_id, name, temporality, bands,
  current_snapshot_id); app.raster_snapshots(id, layer_id, observed_at,
  observed_end, footprint geometry(4326), crs, bands jsonb, size_bytes, status,
  cell_size_m, metadata); status 'promoted' is live.
- data.rasters(layer_id, snapshot_id, observed_at, observed_end, rast):
  out-db rasters, one row per stored tile. Read a pixel with
  ST_Value(rast, ST_Transform(ST_SetSRID(ST_Point(lon, lat), 4326), ST_SRID(rast)))
  filtered with ST_Intersects on the same transformed point. Summary stats:
  ST_SummaryStatsAgg(rast, 1, true).
- app.data_tables(id, integration_id, spec): vector/tabular outputs, stored as
  data.<id>.
- data.aoi: the deployment's area of interest polygon.
Keep queries cheap: filter by layer and snapshot, sample a few points or one
tile rather than scanning a whole raster.

When done, reply with only a JSON object:
{"checks": [{"check": "...", "verdict": "pass|fail|unverified", "evidence": "..."}],
 "overall": "pass|fail|partial", "notes": "..."}
"overall" is pass only if every check passed, fail if any failed, else partial.`

/** Runs one read-only query for the judge; returns rows or the error as text. */
async function readOnlyQuery(pool: pg.Pool, sql: string): Promise<string> {
  const trimmed = sql.trim().replace(/;\s*$/, "")
  if (!/^(select|with)\b/i.test(trimmed) || trimmed.includes(";")) return "Error: one SELECT (or WITH ... SELECT) only"
  const client = await pool.connect()
  try {
    await client.query("BEGIN TRANSACTION READ ONLY")
    await client.query("SET LOCAL statement_timeout = '60s'")
    const result = await client.query(trimmed)
    const text = JSON.stringify(result.rows.slice(0, 50))
    return `${result.rowCount} rows${(result.rowCount ?? 0) > 50 ? " (first 50)" : ""}:\n${text.length > 8000 ? text.slice(0, 8000) + "…" : text}`
  } catch (err) {
    return `Query error: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    await client.query("ROLLBACK").catch(() => {})
    client.release()
  }
}

/**
 * Checks an installed integration against its prompt's acceptance checks with
 * a fixed judge model and read-only SQL. An LLM verdict: spot-check it.
 */
export async function judge(
  model: LanguageModel,
  pool: pg.Pool,
  prompt: DesignPrompt,
  integrationId: string,
  context: string
): Promise<JudgeResult> {
  // Number the bullets so every session is judged on the same checks: the
  // judge otherwise merges or splits them, and pass counts stop comparing
  const bullets = prompt.acceptance
    .split(/\n(?=- )/)
    .map(b => b.replace(/^- /, "").replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean)
  const checks = bullets.map((b, i) => `${i + 1}. ${b}`).join("\n")
  const result = await generateText({
    model,
    system: SYSTEM,
    prompt: `Request given to the agent:\n${prompt.prompt}\n\nAcceptance checks (return exactly one entry per numbered check, in order, with "check" set to its text):\n${checks}\n\nIntegration id: ${integrationId}\n\n${context}`,
    tools: {
      query_sql: tool({
        description: "Run one read-only SELECT against the deployment database; returns up to 50 rows as JSON.",
        inputSchema: z.object({ sql: z.string() }),
        execute: async ({ sql }) => readOnlyQuery(pool, sql)
      })
    },
    stopWhen: stepCountIs(30),
    maxOutputTokens: 8000
  })
  const tokens = (result.totalUsage.inputTokens ?? 0) + (result.totalUsage.outputTokens ?? 0)
  const json = result.text.match(/\{[\s\S]*\}/)
  try {
    const parsed = JSON.parse(json ? json[0] : "") as Omit<JudgeResult, "tokens">
    return { checks: parsed.checks ?? [], overall: parsed.overall ?? "partial", notes: parsed.notes ?? "", tokens }
  } catch {
    return { checks: [], overall: "partial", notes: `Judge reply was not JSON: ${result.text.slice(0, 500)}`, tokens }
  }
}
