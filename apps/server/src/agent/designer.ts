import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { LanguageModel, ToolSet, tool } from "ai"
import pg from "pg"
import { z } from "zod"
import { IntegrationDefinition, RuntimeId } from "@data-integrator/definitions"
import {
  AgentEventListener,
  AgentImplementation,
  MessageRejectedError,
  SessionAttachment,
  SessionDeleteRefusedError,
  ToolOutcome
} from "./types.js"
import { RunFlag } from "../validation.js"
import { effectiveJobLimits, effectiveTmpQuotaMb, ExecutorDeps, executeRun, jobFailureReason } from "../executor.js"
import { resolveSettings } from "../integrationSettings.js"
import { createJobTmp } from "../jobTmp.js"
import {
  adoptSessionFiles,
  AwaitingFileError,
  currentVersions,
  FileVersion,
  getVersion,
  ResolvedFiles,
  resolveFiles
} from "../files.js"
import { ID_PATTERN, definitionHash, installIntegration, validateDefinition } from "../install.js"
import { COUNTRIES, lookupCountry } from "../countries.js"
import { materializeInputs } from "../materialize.js"
import { startPinnedRun, startProductionRun } from "../runService.js"
import { cleanupScratch, draftSchema, scratchWorkDir } from "../scratch.js"
import { getSecrets, listAllSecrets, listSecrets, SECRET_NAME_PATTERN, secretRedactor } from "../secrets.js"
import { getLocales } from "../settings.js"
import { detectBaseLocale, refreshChangedStrings, translateDefinition, wrapDefinitionStrings } from "../localizeCatalog.js"
import { loadSkillsIndex, readSkill, SkillSummary } from "../skills.js"
import { searchLibrary } from "./libraryTool.js"

/** Client state of a designer session: the draft and its certification. */
export interface DesignerState {
  /** Draft integration definition being designed */
  definition: IntegrationDefinition
  /** Successful cold run certifying a definition hash and the file versions it read, if any */
  coldRun: { definitionHash: string; runId: string; files?: Record<string, string> } | null
  /** Most recent test run, for status display */
  lastRun: { runId: string; status: string; cold: boolean } | null
  /** Consecutive failed runs sharing one error signature (thrash guard); absent until a run fails */
  failStreak?: { signature: string; count: number } | null
  /** True when finish started the fresh install's first production load; absent before finish */
  firstLoadStarted?: boolean
  /** Detected language of the draft's authored text, with the sample it was detected on */
  baseLocale?: { code: string; sample: string } | null
  /** Latest credentials request the agent made; the session view renders it as a card */
  secretRequest?: SecretRequest | null
  /** File versions this session works with, per slot; slots without a pin read the integration's current version */
  files?: Record<string, string> | null
  /** True until the seeded files are announced to the agent in the first message */
  filesNote?: boolean
}

/** One credential the agent needs the operator to provide. */
export interface SecretRequestItem {
  /** Secret name the code reads via ctx.secrets */
  name: string
  /** One line on what it is and what it unlocks */
  purpose: string
  /** Where to obtain it: a URL or a short hint; optional */
  help?: string
  /** An installed integration already holding a value under the same name, offered for copying */
  copyFrom?: string | null
  /** Snippet that makes one authenticated call and raises on failure; optional */
  check?: string | null
}

/** A credentials request: the names, why, and where to get them. */
export interface SecretRequest {
  /** Requested credentials in the order to show them */
  items: SecretRequestItem[]
  /** When the request was made (ISO) */
  requestedAt: string
}

/** Everything the designer needs: executor deps plus the model. */
export interface DesignerDeps extends ExecutorDeps {
  /** Language model for the session loop */
  model: LanguageModel
  /** library/skills directory; absent or missing on disk means no skills */
  skillsDir?: string | null
  /** Library root, for search_library; absent means no library */
  libraryPath?: string | null
}

/** Plain text of a draft field that may be a plain string or a LocalizedString. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value
  if (value && typeof value === "object") {
    const ls = value as { _base?: string; [k: string]: unknown }
    if (typeof ls._base === "string" && typeof ls[ls._base] === "string") return ls[ls._base] as string
  }
  return ""
}

/** Snippet resource limits: exploration jobs stay small and short. */
const SNIPPET_LIMITS = { cpus: 2, memoryMb: 2048, timeoutMs: 180_000 }

/** Where the job reads a slot's file. */
function inPath(slotId: string, ext: string): string {
  return `/in/files/${slotId}${ext}`
}

/** A version as notes and tool results name it. */
function describeVersion(version: FileVersion): string {
  return `${version.filename} (v${version.version}, ${version.sizeBytes} bytes)`
}

/** Version id per slot of resolved files. */
function fileIds(files: ResolvedFiles): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([slotId, version]) => [slotId, version.id]))
}

/** True when both maps pin the same version for every slot. */
function sameFiles(a: Record<string, string>, b: Record<string, string>): boolean {
  const slots = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...slots].every(slotId => a[slotId] === b[slotId])
}

/**
 * True unless the session pins a declared slot to a version other than the
 * one its cold run read (a cheap check for the session view; finish also
 * re-resolves the slots that read current versions).
 */
export function pinsMatchColdRun(state: DesignerState): boolean {
  const certified = state.coldRun?.files ?? {}
  const declared = state.definition.files ?? {}
  return Object.entries(state.files ?? {}).every(([slotId, versionId]) => !(slotId in declared) || certified[slotId] === versionId)
}

/**
 * Fresh draft state for a new designer session. With no integrationId the
 * draft starts unbound (empty id) and the agent names it on the first
 * write_definition.
 */
export function initialDesignerState(integrationId = ""): DesignerState {
  return {
    definition: {
      id: integrationId,
      // Draft boundary is plain-string; wrapDefinitionStrings localizes at save
      name: integrationId as unknown as IntegrationDefinition["name"],
      trigger: {},
      runtime: "python",
      destinations: [],
      code: "",
      contract: 2
    },
    coldRun: null,
    lastRun: null,
    failStreak: null
  }
}

/** Failed runs count as "the same" when their errors match after path noise is stripped. */
export function errorSignature(error: string): string {
  return error.replace(/\/tmp\/[A-Za-z0-9_-]+/g, "/tmp/*").slice(0, 300)
}

/** Identical failures before the agent is told to stop and ask the user. */
const FAIL_STREAK_WARN = 3

/** Identical failures before the session is force-paused. */
const FAIL_STREAK_PAUSE = 5

/** System prompt: definition format, code contract, and the design workflow. */
const SYSTEM = `You are the integration designer for the mWater Data Integrator platform. You design and
repair one integration per session: a JSON definition plus one self-contained code file
that ingests external data into Postgres tables and/or the raster catalog.

# Definition format (contract 2)
Write every human-facing text field (name, description, source.name, limitations, destination
and column names, enum value names, band names) as a plain string in the language of this
conversation - the platform detects the language, stores the text as a localized string, and
translates it into the deployment's other languages after you finish. Never attempt
multilingual output yourself. When you read the definition back these fields appear as
{_base, <locale>: text} objects; echo them through unchanged unless editing the text.
Fields: id (snake_case; immutable once set), name, description [always write one: 1-2
sentences on what the integration ingests and produces - it is how people tell
integrations apart in the list], source? {name, url?, provider?,
license?, documentation?, limitations?}, trigger ({cron: "..."} and/or {webhook: true, webhookDelaySeconds?}, or {} for
manual only), secrets? [names only], aoi? {bbox: [west, south, east, north], countries?: [ISO3...]} | null
(omit aoi to inherit the deployment default at run time; explicit null means the source's full extent;
when writing an explicit aoi, take coordinates from lookup_country — never from memory, so agent-authored
boxes match the UI pickers exactly),
runtime ("python" | "node"), limits? {timeoutMs?, memoryMb?, cpus?},
destinations [below], validation? {expectedCadence? [ISO 8601 duration such as "P1D": the home page
flags the integration when no run succeeds within twice it], ranges? [{destinationId, field, min?, max?}:
physical bounds a numeric column or band can never cross, such as population >= 0 or a fraction 0..1;
violations flag the run, never reject it, so do not use them for plausible-but-unusual values]},
settings? {settingId: {label, description?, type: "integer"|"boolean"|"choice"|"text", default,
min?, max? [integer], choices? [{value, label}] [choice], pattern? [text, a regex the whole value
must match], appliesOn? "every-run"|"rebuild"}}: options an operator may change on the integration
page without editing code, such as how much history to load or a product variant. Declare one only
for a real choice the code honours; the default must be the value you would pick. appliesOn
"rebuild" marks a setting the code reads only when previousState is null (history depth), so a
change shows on the next rebuild. settingValues? {settingId: value} holds the deployment's choices;
leave it out unless the user asks for a non-default value,
code (via edit_code, not write_definition), contract: 2.

Destinations:
- {kind: "table", tableId, name? [human-readable display name], action:
  "replace"|"append"|"merge", mergeColumns?
  [required for merge, must name declared columns], description? [one sentence on what
  the table contains, shown in the data catalog], columns: [{id, name?, type: "text"|
  "number"|"integer"|"boolean"|"date"|"datetime"|"geometry"|"enum"|"json",
  enumValues? [{id, name}] when type is "enum", units?}]}
- {kind: "raster", layerId, name?, description? [one sentence on what the layer
  shows, shown in the data catalog], temporality: "time-series"|"current-only",
  retention? {days} [time-series only: snapshots observed more than days ago are
  deleted; set it for daily or finer layers whose history grows without bound], bands:
  [{id, name?, units?, nodata?, rendering? {resampling: "nearest"|"average",
  colorMap? [{value, color: "#rrggbb" or "#rrggbbaa"}]}}]}
Every raster band MUST declare nodata (matching the value written into the
COG) and a rendering.colorMap with value stops spanning the data range - the
map draws nothing without a colorMap, and SQL statistics count sentinel
pixels without nodata. Make nodata transparent by relying on it (it always
renders transparent) rather than adding a stop for it. Derive colorMap stops
from the values actually ingested for this deployment's
area (check statistics on a produced raster before finishing), NOT from the
variable's theoretical global range: a global-scale ramp renders a small
region's data as one flat color.
Fill source.limitations with the caveats a data consumer needs to interpret
this dataset correctly: resolution and coverage limits, known biases or
calibration gaps, revision/timeliness behavior, and what absence of data does
NOT mean (e.g. no observation is not "no flood"). State only what the source
documents or what you verified against the ingested data, in 1-3 plain
sentences.

# Code contract
One file, entrypoint run(ctx).
Python: def run(ctx); ctx.definition, ctx.secrets, ctx.previous_state, ctx.webhook_data,
ctx.params, ctx.catalog, ctx.in_dir, ctx.work_dir, ctx.out_dir, ctx.tmp_dir.
Node: export default async function run({definition, secrets, previousState, webhookData,
params, catalog, inDir, workDir, outDir, tmpDir}).
params holds every declared setting at the deployment's value or its default, and nothing
else; read settings from it, never from the definition. previousState is null on the first run
and on a rebuild (which also empties /work): produce everything in scope then, honouring
history-depth settings, and work incrementally from the state otherwise.
catalog maps each declared raster layerId to {snapshots: [{timestamp, timestampEnd?,
sources}]} already promoted, ascending. Use it within incremental runs to skip periods
already published; return no artifact for a period that needs no update.
webhookData is the batch of deliveries since the last run. Never fail the whole
batch on a malformed event: load the valid events, skip the bad ones, and report
each rejection loudly in the log with a rejected count in the result.
Return: {data?: {tableId: [row objects matching declared columns]}, tables?: [{tableId,
path (relative to /out), format? "geojson"|"fgb"|"gpkg"|"csv"}], rasters?: [{layerId,
path (relative to /out, e.g. "pop_2023.tif"), timestamp, timestampEnd?, footprint?
[w,s,e,n], crs?, metadata?}], state?: any}. Geometry columns take GeoJSON; raster files should be COGs.
A raster snapshot is normally one file (path). When the product is a set of tiles too
large to merge (high resolution over a large extent), give sources: [{path, footprint?}]
instead of path and the tiles are mosaicked at read time. sources: [] publishes an empty
snapshot, meaning nothing was observed for that time (an all-clear hazard map); it
replaces the previous snapshot. Leaving the raster out means no update.
data is inline rows and travels through stdout, which is capped at 10 MB total. For
anything larger, and for any geometry-heavy table (boundaries, catchments, road networks),
write the rows to /out as a file instead and declare it in tables[]: geopandas
to_file("{ctx.out_dir}/admin1.fgb") then {"tables": [{"tableId": "admin1", "path":
"admin1.fgb"}]}. There is no size limit on that path and it is faster to load, so never
split a dataset across many runs, and never simplify geometry, merely to fit stdout. File
fields are matched to declared columns by name and cast; the file's geometry column feeds
the declared geometry column whatever it is named, and is reprojected to 4326 if needed.
One layer per file. A table is either inline or a file, never both in one run.
/work persists between runs of this integration; treat it as a cache, never as the source
of truth, and keep in it only what a later run reuses (raw downloads worth not fetching
again). /tmp (ctx.tmp_dir) is this run's own disk, empty at the start and deleted after:
put unpacked archives, VRTs, intermediate GeoTIFFs and one-off downloads there, and run
GDAL subprocesses with cwd there. Both have disk quotas. previousState is the state returned by the last successful run (null on the
first run); use it for incremental ingestion. print/console.log output goes to the run log.

Python image: gdal CLI tools, rasterio, geopandas, pandas, numpy, scipy, xarray, netCDF4,
h5netcdf, h5py, cfgrib, pyproj, requests, cdsapi, ecmwf-opendata, openpyxl (xlsx), xlrd
(legacy xls), odfpy (ods). Node image: csv-parse, fast-xml-parser,
date-fns. Jobs have public-internet egress only; private networks are blocked.

These curated libraries are ALL you get. Every snippet and run starts a fresh
container, so installing packages does not work: a pip install lasts only to the end
of that one snippet, and re-installing each run is not an acceptable design. Formats
you can read: GeoTIFF/COG and the rest of GDAL's small build (rasterio, gdal CLI),
NetCDF-3/4 (xarray, engine netcdf4 or h5netcdf), plain HDF5 (h5py), GRIB (xarray +
cfgrib), and the usual CSV/JSON/XML and vector formats (geopandas, ogr2ogr). GDAL
itself has NO netCDF or HDF driver here, so read those with xarray/h5py and write
results out as GeoTIFF; gdalinfo and gdal_translate will reject them.

If a source publishes a format nothing here can read, or is only available by
scraping rendered map images, STOP and tell the user plainly: name the source, say
what blocks it, and offer alternative sources or formats. Never reverse-engineer
pixel colors from published map images back into data values, and never build an
integration whose numbers you cannot trace to a documented source value.

# Inputs (derived integrations)
An integration can consume platform data instead of (or as well as) external
sources. Declare inputs keyed by an input id:
- {kind: "raster", layerId, select: "current" | {latest: N} | {from: iso, to?: iso}}
- {kind: "table", tableId, columns?, where? [{column, op: "="|"!="|">"|">="|"<"|"<="|"in",
  value}], format? "gpkg"|"json"|"csv" (default gpkg on python, json on node)}
The server materializes them under /in before each run and snippet: raster
snapshots as /in/<inputId>/<timestamp>.tif, table extracts as /in/<inputId>.<ext>,
described by /in/manifest.json (paths, snapshot ids, timestamps, band order, row
counts). Read the manifest rather than guessing paths. Inputs must not reference
this integration's own destinations.

# Files (uploaded by users)
An integration can read files people upload: a spreadsheet, a shapefile, a
GeoPackage, a CSV. Declare a slot per file: files: {<slotId>: {description?
[what the file is and must contain, shown beside the upload button], accept?
[".xlsx", ...] lowercase extensions}}. Each upload is a new version; a run reads
the slot at /in/files/<slotId><ext>, described under files in /in/manifest.json
(path, version, filename, sha256). Read the manifest for the path, since the
extension follows the upload. When the user attaches a file, a note at the top of
their message names the slot and path; snippets see it straight away, even before
the slot is declared, but runs read declared slots only. Never ask the user to
paste file contents into the chat.
Once you finish, replacing the file is the user's job and needs no designer, so
the code must cope with the next version on its own:
- Check the structure first (sheet names, header row, required columns, geometry
  type) and fail with a plain-language message naming what was expected and what
  was found, e.g. "Sheet 'Inventory' is missing column 'Latitude'; found: Lat, Lon,
  Name". That message is what the user sees when a replacement has drifted.
- Use action "replace" for tables built from a file: merge never deletes, so rows
  removed from the file would persist.
- Do file work in Python. Read zipped shapefiles in place with geopandas or
  ogr via /vsizip/ (e.g. "/vsizip//in/files/districts.zip"), never by unzipping
  them, and reproject geometry to EPSG:4326.

# Workflow
0. If the draft id is empty, choose one (short snake_case derived from the request)
   and save an initial definition with write_definition before anything else; the
   sandbox tools are rejected until the draft has an id.
0b. For a new integration, call search_library with the request's key terms before
   exploring anything. If an entry covers the request (e.g. "river discharge" when a
   GloFAS entry exists) and is not installed, say so and ask_user whether to install
   it from the Library instead of building: give the install link the tool returned
   as a markdown link, and only keep building if the user chooses to. If it is
   installed already, say so and ask whether the request is really a change to it.
1. Explore candidate sources with run_snippet (network is live; print what you learn).
2. Propose a plan and wait for confirmation - always, even when the request seems
   fully specified: in plain text, tell the user the data source you chose (name
   and URL), what will be ingested at what cadence, the destination tables/layers,
   key assumptions, and any open questions - then call ask_user to confirm (e.g.
   "Proceed as planned" plus meaningful alternatives). Never call edit_code or
   run_integration before the user has answered; re-confirm whenever you later
   change source or scope.
3. write_definition for everything except code; edit_code for the code.
4. Iterate with run_integration (warm: /work cache makes retries fast). Test runs
   write to a session-scoped scratch area; nothing touches installed integrations
   or their data until finish. query_table reads your scratch tables by plain name.
5. When it works, run_integration with cold=true (fresh /work, null previousState).
6. finish saves: it installs the certified definition as the real integration,
   discards the scratch area, and on a fresh install starts the first production
   run so data begins loading immediately. It is rejected unless the current
   code passed a cold run unchanged.

Rules: never fabricate data. Credentials: reference secrets by name only (lowercase
snake_case, e.g. weather_api_key); values are stored per integration, encrypted, and
never pass through this conversation. Before declaring a new name call list_secrets:
when the deployment already holds a credential for the same service, request that
name and set copyFrom so the operator can reuse it. To obtain a value call
request_secrets - it shows the operator a form inside this session and pauses until
they save; never ask for a value in chat and never tell them to go to another page.
Include a check snippet whenever one cheap authenticated call can prove the value
works. Prefer incremental state
over re-downloading. Whenever a choice is not forced (dataset variant, resolution,
year, aggregation), ask_user rather than guessing. Plain text with no tool calls also
pauses the session, for open-ended questions. Your plain text renders as markdown.

# Prefer published products over home-made derivations
For any derived quantity (anomalies, climatologies, indices, trends, composites),
look for a published, validated product first: the source skills, the deployment's
library, and the provider's own catalog. Ingest that product as-is. Do not compute
your own anomaly or climatology from a raw series, and do not chain several sources
into a new indicator: rolling your own geospatial product is expert work and goes
quietly wrong. If no published product exists, say so and ask_user before deriving
anything beyond simple raster statistics (clip, resample, per-region summary) or
overlays. When the user still wants a derivation, state its limitations in the
definition's limitations field.

# Area of interest
The deployment's default area of interest is a default, not a boundary. An
integration may declare its own aoi (from lookup_country) to cover another country
or region; when a user asks for data outside the default area, say that and offer
to set the integration's own area rather than declining.
In code, read the area from ctx.definition.aoi and nothing else. The platform
injects the effective area before launch; when the field is absent the run covers
the source's full extent, so the code must either serve the world or fail with a
clear error. Never fall back to a built-in example area (a hard-coded country or
box) because "no AOI was injected": in a deployment that means silently wrong data.

# Audience
Most users are water and sanitation staff, not GIS specialists. Explain a domain
term in plain words the first time it appears in a conversation, e.g. "dekadal
(every 10 days)", "FPAR (a satellite measure of green vegetation)", then use it
freely.`

/**
 * The designer agent: tools to explore a source, shape the draft definition,
 * test it through the real executor, and finish behind the cold-run gate.
 */
export class DesignerImplementation implements AgentImplementation<DesignerState> {
  /** Session kind for storage */
  readonly kind = "designer" as const
  /** Language model for the loop */
  readonly model: LanguageModel
  /** Hard cap on model calls per session */
  readonly maxSteps = 200

  private deps: DesignerDeps

  /** Skills index loaded once at construction; [] without a skills library. */
  private skills: SkillSummary[]

  /** Creates the implementation over executor deps plus a model. */
  constructor(deps: DesignerDeps) {
    this.deps = deps
    this.skills = deps.skillsDir ? loadSkillsIndex(deps.skillsDir) : []
    this.model = deps.model
  }

  /** System prompt (state-independent; authoritative state travels as tool results). */
  system(): string {
    if (this.skills.length === 0) return SYSTEM
    const index = this.skills.map(s => `- ${s.id}: ${s.description || s.name}`).join("\n")
    return `${SYSTEM}

# Skills
Reusable know-how about sources and techniques, from the deployment's library.
Before working against a source or problem one of these covers, call read_skill
and follow it — hard-won facts about protocols, layouts, and quirks beat
rediscovery:
${index}`
  }

  /** Tool schemas; execution is in execute(). */
  tools(): ToolSet {
    return {
      get_definition: tool({
        description:
          "Read the current draft definition, and the files this session's snippets and runs read. Code is elided unless includeCode is true.",
        inputSchema: z.object({
          includeCode: z.boolean().optional().describe("Include the full code text")
        })
      }),
      write_definition: tool({
        description:
          "Replace the draft definition with the given JSON. The code field is preserved from the current draft; use edit_code for code. When the draft has no id yet, the incoming id names the integration; after that the id cannot change.",
        inputSchema: z.object({
          definitionJson: z.string().describe("Complete definition as JSON text")
        })
      }),
      edit_code: tool({
        description:
          "Edit the integration code by exact-string replacement. oldString must occur exactly once. Pass an empty oldString only when the code is still empty (sets the whole file).",
        inputSchema: z.object({
          oldString: z.string().describe("Exact text to replace; empty only for initially empty code"),
          newString: z.string().describe("Replacement text")
        })
      }),
      run_snippet: tool({
        description:
          "Run a throwaway code snippet in the sandbox (same ctx, /work and network as a real run; nothing is committed). Python snippets print to stdout; keep them self-contained.",
        inputSchema: z.object({
          code: z.string().describe("Snippet source"),
          runtime: z.enum(["python", "node"]).optional().describe("Defaults to the draft's runtime")
        })
      }),
      run_integration: tool({
        description:
          "Execute a real run of the draft through the executor, into this session's scratch area (scratch tables and preview layers; installed integrations are untouched). cold=true wipes /work and nulls previousState; a successful cold run certifies the current definition for finish.",
        inputSchema: z.object({
          cold: z.boolean().describe("Fresh workspace certification run")
        })
      }),
      query_table: tool({
        description:
          "Run one read-only SELECT against the data schema (destination tables, and the rasters table: promoted snapshots of installed layers as out-db PostGIS rasters - ST_Value/ST_SummaryStats work for exploring an input layer's values; this draft's own test rasters are not in it). Returns up to 50 rows as JSON.",
        inputSchema: z.object({
          sql: z.string().describe("A single SELECT (or WITH...SELECT) statement")
        })
      }),
      search_library: tool({
        description:
          "Search the deployment's integration Library for a ready-made entry covering a request (plain words: 'river discharge', 'drought', 'population'). Returns matching entries with install status, what they produce, and an install link to offer the user instead of building from scratch.",
        inputSchema: z.object({
          query: z.string().describe("The data being asked for, in plain words")
        })
      }),
      read_skill: tool({
        description:
          "Read the full text of a skill from the index in the system prompt: source and technique know-how (protocols, file layouts, quirks, working snippets). Read the relevant skill before designing against a source it covers.",
        inputSchema: z.object({
          id: z.string().describe("Skill id from the index")
        })
      }),
      lookup_country: tool({
        description:
          "Look up country bounding boxes in the product's built-in list (Natural Earth derived) by name or ISO 3166-1 alpha-3 code. The authoritative source for aoi coordinates: the same data the UI pickers use.",
        inputSchema: z.object({
          query: z.string().describe("Country name (partial matches allowed) or ISO3 code")
        })
      }),
      ask_user: tool({
        description:
          "Ask the user a question with selectable options and pause until they answer. Use it to confirm the plan and for any unforced choice (source, dataset variant, resolution, cadence). The user may also reply free-form.",
        inputSchema: z.object({
          question: z.string().describe("The question, markdown allowed; include the context needed to choose"),
          options: z.array(z.string()).min(2).max(5).describe("Short answer choices (2-5)")
        })
      }),
      request_secrets: tool({
        description:
          "Ask the operator for credentials. Declares the names in the draft, shows a form in the session (one field per name, with your purpose and help text), and pauses until the values are saved. The values never reach you; run again once the tool result or the operator says they are set. Requires a saved draft (write_definition).",
        inputSchema: z.object({
          secrets: z
            .array(
              z.object({
                name: z.string().describe("Secret name the code reads via ctx.secrets; lowercase snake_case"),
                purpose: z.string().describe("One line: what it is and what it unlocks, e.g. 'API key for api.weather.example.org'"),
                help: z.string().optional().describe("Where to obtain it: a URL or a short hint"),
                copyFrom: z
                  .string()
                  .optional()
                  .describe("Installed integration id that already stores this name (from list_secrets), offered for copying"),
                check: z
                  .string()
                  .optional()
                  .describe(
                    "Snippet in the draft's runtime that makes one cheap authenticated call using ctx.secrets and raises on failure; run after the operator saves, so a wrong value is caught before a full run"
                  )
              })
            )
            .min(1)
            .max(8)
        })
      }),
      list_secrets: tool({
        description:
          "List the credential names stored on this deployment and which installed integration holds each (never values). Call before declaring a new secret name: reuse an existing name for the same service via request_secrets with copyFrom.",
        inputSchema: z.object({})
      }),
      finish: tool({
        description:
          "Save and end the session: installs the certified definition as the real integration and discards the scratch area. Rejected unless the current definition passed a cold run unchanged.",
        inputSchema: z.object({
          summary: z.string().describe("One-paragraph summary of what was built")
        })
      })
    }
  }

  /** Executes one tool call. */
  async execute(
    name: string,
    input: unknown,
    state: DesignerState,
    events: AgentEventListener,
    sessionId: string
  ): Promise<ToolOutcome<DesignerState>> {
    const args = (input ?? {}) as Record<string, unknown>
    switch (name) {
      case "get_definition":
        return await this.getDefinition(state, args.includeCode === true, sessionId)
      case "write_definition":
        return await this.writeDefinition(state, String(args.definitionJson ?? ""), events, sessionId)
      case "edit_code":
        return this.editCode(state, String(args.oldString ?? ""), String(args.newString ?? ""))
      case "run_snippet":
        return await this.runSnippet(state, String(args.code ?? ""), args.runtime as RuntimeId | undefined, events, sessionId)
      case "run_integration":
        return await this.runIntegration(state, args.cold === true, events, sessionId)
      case "query_table":
        return await this.queryTable(String(args.sql ?? ""), sessionId)
      case "read_skill":
        return this.readSkill(String(args.id ?? ""))
      case "search_library":
        return { result: await searchLibrary(this.deps.pool, this.deps.libraryPath ?? null, String(args.query ?? ""), await this.sessionLocale(sessionId)) }
      case "lookup_country":
        return { result: lookupCountry(String(args.query ?? "")) }
      case "ask_user":
        return this.askUser(args)
      case "request_secrets":
        return await this.requestSecrets(state, args)
      case "list_secrets":
        return await this.listSecretsTool()
      case "finish":
        return await this.finish(state, String(args.summary ?? ""), sessionId)
      default:
        return { result: `Unknown tool ${name}` }
    }
  }

  /** Locale the session was opened in, so library names read the way the user's catalog does. */
  private async sessionLocale(sessionId: string): Promise<string> {
    const row = (await this.deps.pool.query("SELECT locale FROM app.agent_sessions WHERE id = $1", [sessionId])).rows[0]
    return row?.locale ?? "en"
  }

  /** Returns the draft as JSON, eliding code by default, followed by the session's files. */
  private async getDefinition(state: DesignerState, includeCode: boolean, sessionId: string): Promise<ToolOutcome<DesignerState>> {
    const definition = includeCode
      ? state.definition
      : { ...state.definition, code: `<${state.definition.code.length} chars, pass includeCode: true>` }
    return { result: JSON.stringify(definition, null, 2) + (await this.filesSummary(state, sessionId)) }
  }

  /**
   * The files snippets and runs read, per slot, plus what is out of step with
   * the declarations: session files no slot declares, declared slots with no
   * file. Empty when the session involves no files.
   */
  private async filesSummary(state: DesignerState, sessionId: string): Promise<string> {
    const declared = Object.keys(state.definition.files ?? {})
    const pins = state.files ?? {}
    if (declared.length === 0 && Object.keys(pins).length === 0) return ""
    const files = await this.sessionFiles(state, sessionId, "snippet")
    const lines = Object.entries(files).map(
      ([slotId, version]) =>
        `- ${slotId}: ${describeVersion(version)} at ${inPath(slotId, version.ext)}, ${
          pins[slotId] === version.id ? "attached in this session" : "the integration's current version"
        }`
    )
    const undeclared = Object.keys(files).filter(slotId => !declared.includes(slotId))
    const missing = declared.filter(slotId => !files[slotId])
    if (undeclared.length > 0) {
      lines.push(`Not declared under files yet (runs will not read them): ${undeclared.join(", ")}`)
    }
    if (missing.length > 0) lines.push(`Declared slots with no file yet (ask the user to attach one): ${missing.join(", ")}`)
    return `\n\nSession files:\n${lines.length > 0 ? lines.join("\n") : "(none)"}`
  }

  /**
   * The versions this session reads: its pins, else the integration's current
   * version, per declared slot. Runs read declared slots only and are refused
   * when one has nothing; snippets also read pinned slots not declared yet and
   * leave out slots with nothing.
   */
  private async sessionFiles(state: DesignerState, sessionId: string, mode: "run" | "snippet"): Promise<ResolvedFiles> {
    const definition = state.definition
    const declared = definition.files ?? {}
    const pins = Object.fromEntries(
      Object.entries(state.files ?? {}).filter(([slotId]) => mode === "snippet" || slotId in declared)
    )
    return resolveFiles(this.deps.pool, {
      integrationId: definition.id,
      definition,
      pins,
      sessionId,
      includeUndeclaredPins: mode === "snippet",
      skipMissing: mode === "snippet",
      awaitingHint: ": ask the user to attach it in this session"
    })
  }

  /**
   * Prepares a user message that starts a loop: drops pins whose version was
   * purged or deleted since, announces the seeded files on the first message,
   * and records each attachment as the session's pin for its slot, with a
   * note the agent reads. Attachments must be this session's uploads or its
   * integration's versions.
   */
  async prepareMessage(
    sessionId: string,
    state: DesignerState,
    text: string,
    attachments: SessionAttachment[]
  ): Promise<{ text: string; state: DesignerState }> {
    const notes: string[] = []
    const pins = { ...(state.files ?? {}) }
    for (const [slotId, versionId] of Object.entries(pins)) {
      const version = await getVersion(this.deps.pool, versionId)
      if (!version || version.purgedAt) {
        delete pins[slotId]
        notes.push(
          `[The file pinned for slot "${slotId}" was ${version ? "purged by an admin" : "deleted"}; snippets and runs now read the slot's current version, if it has one]`
        )
      } else if (state.filesNote) {
        notes.push(
          `[File slot "${slotId}" holds ${describeVersion(version)}, the version this integration's latest run read; snippets and runs see it at ${inPath(slotId, version.ext)}]`
        )
      }
    }
    for (const attachment of attachments) {
      const version = await getVersion(this.deps.pool, attachment.versionId)
      const owned =
        version !== null &&
        (version.sessionId === sessionId || (state.definition.id !== "" && version.integrationId === state.definition.id))
      if (!version || !owned || version.slotId !== attachment.slot) {
        throw new MessageRejectedError(`No file version ${attachment.versionId} in slot ${attachment.slot} of this session`)
      }
      if (version.purgedAt) throw new MessageRejectedError(`v${version.version} of slot ${attachment.slot} was purged`)
      pins[attachment.slot] = version.id
      notes.push(
        `[Uploaded ${describeVersion(version)} to file slot "${attachment.slot}"; snippets and runs see it at ${inPath(attachment.slot, version.ext)}]`
      )
    }
    return {
      text: notes.length > 0 ? `${notes.join("\n")}\n\n${text}` : text,
      state: { ...state, files: Object.keys(pins).length > 0 ? pins : null, filesNote: false }
    }
  }

  /**
   * Replaces the draft (code preserved); reports validation problems. An
   * unbound draft takes its id from the incoming definition (checked against
   * installed integrations); a bound draft keeps its id.
   */
  private async writeDefinition(
    state: DesignerState,
    definitionJson: string,
    events: AgentEventListener,
    sessionId: string
  ): Promise<ToolOutcome<DesignerState>> {
    let incoming: IntegrationDefinition
    try {
      incoming = JSON.parse(definitionJson)
    } catch (err) {
      return { result: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` }
    }
    let id = state.definition.id
    if (id === "") {
      id = String(incoming.id ?? "")
      if (!ID_PATTERN.test(id)) {
        return { result: `Invalid integration id "${id}": lowercase snake_case starting with a letter` }
      }
      const taken = await this.deps.pool.query("SELECT 1 FROM app.integrations WHERE id = $1", [id])
      if (taken.rows.length > 0) {
        return { result: `Integration id "${id}" is already installed; choose a different id` }
      }
      // Another session may have named its draft this without a row yet; two
      // sessions sharing an id would share its draft, credentials, and files
      const claimed = await this.deps.pool.query(
        `SELECT id FROM app.agent_sessions
         WHERE kind = 'designer' AND id <> $2 AND client_state->'definition'->>'id' = $1 LIMIT 1`,
        [id, sessionId]
      )
      if (claimed.rows.length > 0) {
        return {
          result: `Integration id "${id}" is being designed in another session (${claimed.rows[0].id}); choose a different id, or the user can delete that session to free it`
        }
      }
      events({ type: "integration_bound", integrationId: id })
    }
    // Wrap plain-string names/descriptions as LocalizedStrings based in the
    // authored language: detected from the headline text once, re-detected
    // only when that text changes. The session's UI locale is the fallback.
    const draft = { ...incoming, id, code: state.definition.code }
    const sample = [textOf(draft.name), textOf(draft.description)].filter(Boolean).join("\n")
    let baseLocale = state.baseLocale ?? null
    if (sample && baseLocale?.sample !== sample) {
      const sessionLocale = (await this.deps.pool.query("SELECT locale FROM app.agent_sessions WHERE id = $1", [sessionId]))
        .rows[0]?.locale
      const code = await detectBaseLocale(this.model, sample, sessionLocale ?? "en")
      baseLocale = { code, sample }
    }
    const definition = wrapDefinitionStrings(draft, baseLocale?.code ?? "en")
    let validation = "valid"
    try {
      validateDefinition(definition)
    } catch (err) {
      validation = `INVALID: ${err instanceof Error ? err.message : String(err)}`
    }
    // A valid draft materializes as a draft-status integration row, so
    // per-integration credentials can be attached while the session is still
    // designing (the row is what secrets reference). Later edits update the
    // draft in place; finish archives the final version and flips it ready.
    if (validation === "valid") {
      const existing = await this.deps.pool.query("SELECT status FROM app.integrations WHERE id = $1", [id])
      if (existing.rows.length === 0) {
        const session = await this.deps.pool.query("SELECT user_id FROM app.agent_sessions WHERE id = $1", [sessionId])
        await installIntegration(this.deps.pool, definition, "draft", session.rows[0]?.user_id ?? null)
      } else if (existing.rows[0].status === "draft") {
        await this.deps.pool.query("UPDATE app.integrations SET definition = $2, updated_at = now() WHERE id = $1", [
          id,
          JSON.stringify(definition)
        ])
      }
      // Files attached before the row existed belong to the session alone; the integration owns them from here
      await adoptSessionFiles(this.deps.pool, sessionId, id)
    }
    const next = { ...state, definition, baseLocale }
    return { result: `Draft saved. Validation: ${validation}${await this.filesSummary(next, sessionId)}`, state: next }
  }

  /** Exact-string code edit; the empty oldString only initializes empty code. */
  private editCode(state: DesignerState, oldString: string, newString: string): ToolOutcome<DesignerState> {
    const code = state.definition.code
    let next: string
    if (oldString === "") {
      if (code !== "") return { result: "Error: oldString is required when code is not empty" }
      next = newString
    } else {
      const count = code.split(oldString).length - 1
      if (count === 0) return { result: "Error: oldString not found in code" }
      if (count > 1) return { result: `Error: oldString occurs ${count} times; provide a longer unique string` }
      next = code.replace(oldString, newString)
    }
    return {
      result: `Code updated (${next.length} chars)`,
      state: { ...state, definition: { ...state.definition, code: next } }
    }
  }

  /** Runs a scratch snippet in the sandbox against the draft's context. */
  private async runSnippet(
    state: DesignerState,
    code: string,
    runtime: RuntimeId | undefined,
    events: AgentEventListener,
    sessionId: string
  ): Promise<ToolOutcome<DesignerState>> {
    const effectiveRuntime = runtime ?? state.definition.runtime
    const image = this.deps.images[effectiveRuntime]
    if (!image) return { result: `No image configured for runtime ${effectiveRuntime}` }
    const secrets = await this.loadSecrets(state)
    if (typeof secrets === "string") return { result: secrets }
    const redact = secretRedactor(secrets)

    const workDir = scratchWorkDir(this.deps.workRoot, sessionId)
    await mkdir(workDir, { recursive: true })
    const outDir = await mkdtemp(path.join(tmpdir(), "snippet-out-"))
    const tmpDir = await createJobTmp(this.deps.workRoot, "snippet")
    let inDir: string | undefined
    try {
      const files = await this.sessionFiles(state, sessionId, "snippet")
      const readsFiles = Object.keys(files).length > 0
      if (readsFiles && !this.deps.files) return { result: "Error: this server has no file store configured" }
      if (readsFiles || (state.definition.inputs && Object.keys(state.definition.inputs).length > 0)) {
        // Under the file store when versions are read, so they hardlink in
        inDir = readsFiles ? await this.deps.files!.jobDir() : await mkdtemp(path.join(tmpdir(), "snippet-in-"))
        await materializeInputs(this.deps, state.definition, inDir, files)
      }
      // Snippets count against the host's sandbox memory and the deployment ceilings like runs
      const limits = effectiveJobLimits(SNIPPET_LIMITS, this.deps)
      const release = this.deps.sandboxes
        ? await this.deps.sandboxes.acquire(limits.memoryMb, reason => events({ type: "job_log", line: reason }))
        : () => {}
      const result = await this.deps.runner.run(
        {
          image,
          payload: {
            mode: "snippet",
            code,
            definition: state.definition,
            secrets,
            previousState: null,
            params: resolveSettings(state.definition)
          },
          mounts: { workDir, outDir, inDir, tmpDir },
          limits: {
            cpus: limits.cpus,
            memoryMb: limits.memoryMb,
            timeoutMs: limits.timeoutMs,
            tmpDiskMb: effectiveTmpQuotaMb(state.definition.limits, this.deps) ?? undefined
          }
        },
        { onStderrLine: line => events({ type: "job_log", line: redact(line) }) }
      ).finally(release)
      const parts = [
        result.status === "failed" && result.abortedReason === undefined
          ? `Snippet failed: ${jobFailureReason(result, limits.memoryMb)}`
          : `Snippet ${result.status} (exit ${result.exitCode})`
      ]
      if (result.stdout) parts.push(`stdout:\n${redact(result.stdout)}`)
      if (result.status !== "succeeded" && result.stderrTail) parts.push(`stderr:\n${redact(result.stderrTail)}`)
      return { result: parts.join("\n") }
    } finally {
      await rm(outDir, { recursive: true, force: true })
      await rm(tmpDir, { recursive: true, force: true })
      if (inDir) await rm(inDir, { recursive: true, force: true })
    }
  }

  /**
   * Executes one real run of the draft in the session's scratch area (draft
   * schema tables, scratch preview layers). Installed integrations are never
   * touched; cold runs certify for finish, which is what installs.
   */
  private async runIntegration(
    state: DesignerState,
    cold: boolean,
    events: AgentEventListener,
    sessionId: string
  ): Promise<ToolOutcome<DesignerState>> {
    const definition = state.definition
    if (definition.id === "") {
      return { result: "The draft has no integration id yet; save one first with write_definition" }
    }
    try {
      validateDefinition(definition)
    } catch (err) {
      return { result: `Definition invalid: ${err instanceof Error ? err.message : String(err)}` }
    }
    // A missing credential fails before any job is spent on it
    const secretsCheck = await this.loadSecrets(state)
    if (typeof secretsCheck === "string") return { result: secretsCheck }
    // So does a declared file slot with nothing to read
    let files: Record<string, string>
    try {
      files = fileIds(await this.sessionFiles(state, sessionId, "run"))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { result: err instanceof AwaitingFileError ? message : `File error: ${message}` }
    }
    const hash = definitionHash(definition)

    let runId: string
    try {
      const inserted = await this.deps.pool.query(
        `INSERT INTO app.runs (session_id, trigger, status) VALUES ($1, 'agent', 'queued') RETURNING id`,
        [sessionId]
      )
      runId = inserted.rows[0].id
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        return { result: "A run of this session is already queued or running; wait for it to complete." }
      }
      throw err
    }
    const claimed = await this.deps.pool.query(
      `UPDATE app.runs SET status = 'running', claimed_by = 'designer', heartbeat_at = now(), started_at = now()
       WHERE id = $1 AND status = 'queued' RETURNING id, integration_id, trigger, attempt`,
      [runId]
    )
    // The versions resolved above, current ones included, are pinned so the
    // run reads exactly what the certificate will record
    await executeRun(this.deps, claimed.rows[0], {
      cold,
      scratch: { sessionId, definition, files },
      onLogLine: line => events({ type: "job_log", line })
    })

    const final = await this.deps.pool.query("SELECT status, error, stats, log, flags FROM app.runs WHERE id = $1", [runId])
    const { status, error, stats, log, flags } = final.rows[0]
    const parts = [`${cold ? "Cold" : "Warm"} run ${status}.`]
    if (stats) parts.push(`stats: ${JSON.stringify(stats)}`)
    if (flags) {
      parts.push(
        `validation flags (data committed, but check whether the data or the rule is wrong):\n${(flags as RunFlag[]).map(f => `- ${f.message}`).join("\n")}`
      )
    }
    if (error) parts.push(`error: ${error}`)
    if (log) parts.push(`log tail:\n${String(log).slice(-4000)}`)

    let failStreak = state.failStreak ?? null
    let pause = false
    if (status === "succeeded") {
      failStreak = null
      parts.push("Inspect results with query_table (tables) or the stats above (snapshots).")
    } else {
      const signature = errorSignature(String(error ?? "unknown"))
      failStreak =
        failStreak && failStreak.signature === signature
          ? { signature, count: failStreak.count + 1 }
          : { signature, count: 1 }
      if (failStreak.count >= FAIL_STREAK_PAUSE) {
        pause = true
        parts.push(
          `${failStreak.count} consecutive runs failed with the same error; the session is now paused for user guidance.`
        )
      } else if (failStreak.count >= FAIL_STREAK_WARN) {
        parts.push(
          `${failStreak.count} consecutive runs have failed with the same error. Stop retrying variations: explain the problem to the user in plain text and ask how to proceed.`
        )
      }
    }

    const next: DesignerState = {
      ...state,
      lastRun: { runId, status, cold },
      coldRun: cold && status === "succeeded" ? { definitionHash: hash, runId, files } : state.coldRun,
      failStreak
    }
    return { result: parts.join("\n"), state: next, pause: pause || undefined }
  }

  /**
   * One read-only SELECT, capped at 50 rows. The session's scratch schema
   * shadows data, so plain table names hit this session's test output first.
   */
  private async queryTable(sql: string, sessionId: string): Promise<ToolOutcome<DesignerState>> {
    const trimmed = sql.trim()
    if (!/^(select|with)\b/i.test(trimmed) || trimmed.includes(";")) {
      return { result: "Error: a single SELECT (or WITH...SELECT) statement is required" }
    }
    const client = await this.deps.pool.connect()
    try {
      await client.query("BEGIN TRANSACTION READ ONLY")
      // The read-only query role: the agent's SQL never reaches app (users,
      // tokens, secrets), and results go to the model provider
      await client.query("SET LOCAL ROLE sql_engine")
      await client.query("SET LOCAL statement_timeout = '15s'")
      // public carries the PostGIS functions (ST_Value etc. for the rasters table)
      await client.query(`SET LOCAL search_path = ${draftSchema(sessionId)}, data, public`)
      const result = await client.query(trimmed)
      const rows = result.rows.slice(0, 50)
      return { result: `${result.rowCount} rows (showing ${rows.length}):\n${JSON.stringify(rows)}` }
    } catch (err) {
      return { result: `Query error: ${err instanceof Error ? err.message : String(err)}` }
    } finally {
      await client.query("ROLLBACK").catch(() => {})
      client.release()
    }
  }

  /** Presents a structured question and pauses the session for the answer. */
  private askUser(args: Record<string, unknown>): ToolOutcome<DesignerState> {
    const question = String(args.question ?? "").trim()
    const options = Array.isArray(args.options) ? args.options.map(String).filter(o => o.trim() !== "").slice(0, 5) : []
    if (question === "") return { result: "Error: question is required" }
    if (options.length < 2) return { result: "Error: provide at least two options" }
    return { result: "Question shown; the session is paused for the user's answer.", pause: true }
  }

  /**
   * Declares the requested names on the draft, records the request, and
   * pauses the session for the credentials card. Names already stored are
   * reported without pausing. Values never pass through here.
   */
  private async requestSecrets(state: DesignerState, args: Record<string, unknown>): Promise<ToolOutcome<DesignerState>> {
    if (state.definition.id === "") {
      return { result: "Error: save the draft with write_definition first; credentials attach to the integration id" }
    }
    const raw = Array.isArray(args.secrets) ? (args.secrets as Record<string, unknown>[]) : []
    if (raw.length === 0) return { result: "Error: secrets is required (at least one {name, purpose})" }
    const items: SecretRequestItem[] = []
    for (const entry of raw) {
      const name = String(entry.name ?? "").trim()
      const purpose = String(entry.purpose ?? "").trim()
      if (!SECRET_NAME_PATTERN.test(name)) {
        return { result: `Error: invalid secret name "${name}": letters, digits and underscores, starting with a letter` }
      }
      if (purpose === "") return { result: `Error: purpose is required for ${name}` }
      if (items.some(i => i.name === name)) return { result: `Error: ${name} is listed twice` }
      const copyFrom = typeof entry.copyFrom === "string" && entry.copyFrom.trim() !== "" ? entry.copyFrom.trim() : null
      if (copyFrom) {
        const holders = await listSecrets(this.deps.pool, copyFrom)
        if (!holders.some(s => s.name === name)) {
          return { result: `Error: ${copyFrom} holds no secret named ${name} (see list_secrets)` }
        }
      }
      items.push({
        name,
        purpose,
        ...(typeof entry.help === "string" && entry.help.trim() ? { help: entry.help.trim() } : {}),
        copyFrom,
        check: typeof entry.check === "string" && entry.check.trim() ? entry.check : null
      })
    }

    // Declare on the draft so the stored row (what secrets reference) matches
    const declared = new Set(state.definition.secrets ?? [])
    for (const item of items) declared.add(item.name)
    const definition = { ...state.definition, secrets: [...declared] }
    const row = await this.deps.pool.query("SELECT status FROM app.integrations WHERE id = $1", [definition.id])
    if (row.rows.length === 0) {
      return { result: "Error: the draft is not saved yet; write_definition must report a valid draft first" }
    }
    if (row.rows[0].status === "draft") {
      await this.deps.pool.query("UPDATE app.integrations SET definition = $2, updated_at = now() WHERE id = $1", [
        definition.id,
        JSON.stringify(definition)
      ])
    }

    const stored = new Set((await listSecrets(this.deps.pool, definition.id)).map(s => s.name))
    const missing = items.filter(i => !stored.has(i.name)).map(i => i.name)
    const request: SecretRequest = { items, requestedAt: new Date().toISOString() }
    const next: DesignerState = { ...state, definition, secretRequest: request }
    if (missing.length === 0) {
      return { result: `All requested credentials are already set: ${items.map(i => i.name).join(", ")}`, state: next }
    }
    return {
      result: `Credentials requested: ${missing.join(", ")}. The session is paused until the operator saves them; they will tell you when done.`,
      state: next,
      pause: true
    }
  }

  /** Names and owners of every stored credential on the deployment; never values. */
  private async listSecretsTool(): Promise<ToolOutcome<DesignerState>> {
    const all = await listAllSecrets(this.deps.pool)
    if (all.length === 0) return { result: "No credentials are stored on this deployment yet" }
    const lines = all.map(s => `- ${s.name} (held by ${s.integrationId})`)
    return { result: `Stored credential names:\n${lines.join("\n")}` }
  }

  /**
   * Readies a design session for deletion inside the delete's transaction:
   * refused while an integration row carries its id (the integration's own
   * delete owns that) or one of its runs is in progress. Removes its scratch
   * area, scratch runs and the uploads no integration adopted, and hands
   * adopted versions over to their integration alone. The returned cleanup
   * deletes the removed uploads' bytes once the delete commits.
   */
  async beforeDelete(client: pg.PoolClient, sessionId: string): Promise<() => Promise<void>> {
    const bound = await client.query(
      `SELECT i.id FROM app.agent_sessions s
       JOIN app.integrations i ON i.id = NULLIF(s.client_state->'definition'->>'id', '')
       WHERE s.id = $1 LIMIT 1`,
      [sessionId]
    )
    if (bound.rows.length > 0) {
      throw new SessionDeleteRefusedError(
        `This session designs integration ${bound.rows[0].id}; delete the integration to remove it`
      )
    }
    const active = await client.query("SELECT 1 FROM app.runs WHERE session_id = $1 AND status IN ('queued', 'running')", [
      sessionId
    ])
    if (active.rows.length > 0) throw new SessionDeleteRefusedError("A run of this session is in progress; stop it first")
    await cleanupScratch(client, this.deps.store, this.deps.workRoot, sessionId)
    const removed = await client.query(
      "DELETE FROM app.file_versions WHERE session_id = $1 AND integration_id IS NULL RETURNING id, ext",
      [sessionId]
    )
    await client.query("UPDATE app.file_versions SET session_id = NULL WHERE session_id = $1", [sessionId])
    await client.query("DELETE FROM app.runs WHERE session_id = $1 AND integration_id IS NULL", [sessionId])
    await client.query("UPDATE app.runs SET session_id = NULL WHERE session_id = $1", [sessionId])
    return async () => {
      // A file left behind is a version-named file with no row, which store cleanup removes
      for (const row of removed.rows) await this.deps.files?.deleteVersion(row.id, row.ext).catch(() => {})
    }
  }

  /**
   * Runs one requested credential's check snippet against the stored value,
   * outside the agent loop (the card calls this right after a save).
   */
  async checkSecret(state: DesignerState, name: string, sessionId: string): Promise<{ ok: boolean; output: string }> {
    const item = state.secretRequest?.items.find(i => i.name === name)
    if (!item) return { ok: false, output: `No pending request for ${name}` }
    if (!item.check) return { ok: true, output: "No check defined for this credential" }
    const outcome = await this.runSnippet(state, item.check, undefined, () => {}, sessionId)
    const ok = /^Snippet succeeded/.test(outcome.result)
    // The tail carries the exception message; the head is only the verdict
    return { ok, output: outcome.result.slice(-4000) }
  }

  /** Serves one skill's full markdown from the library. */
  private readSkill(id: string): ToolOutcome<DesignerState> {
    if (this.skills.length === 0) return { result: "No skills library on this deployment" }
    const text = this.deps.skillsDir ? readSkill(this.deps.skillsDir, id) : null
    if (text === null) {
      return { result: `No skill "${id}"; the index lists: ${this.skills.map(s => s.id).join(", ")}` }
    }
    return { result: text }
  }

  /**
   * The save: behind the cold-run gate, installs the certified definition as
   * the real integration (creating or updating its tables and layers) and
   * discards the session's scratch area. A fresh install starts empty, so its
   * first production load is started here; an integration that has run before
   * keeps its schedule and manual control.
   */
  private async finish(state: DesignerState, summary: string, sessionId: string): Promise<ToolOutcome<DesignerState>> {
    const hash = definitionHash(state.definition)
    if (!state.coldRun || state.coldRun.definitionHash !== hash) {
      return {
        result:
          "Rejected: finish requires a successful cold run of the current definition. Run run_integration with cold=true (again if you edited anything since)."
      }
    }
    // The certificate covers the files too: code adapted to a new file must
    // not be certified against the old one
    const declaresFiles = Object.keys(state.definition.files ?? {}).length > 0
    let certifiedFiles: Record<string, string> = {}
    if (declaresFiles) {
      let resolved: ResolvedFiles
      try {
        resolved = await this.sessionFiles(state, sessionId, "run")
      } catch (err) {
        return { result: `Rejected: ${err instanceof Error ? err.message : String(err)}` }
      }
      // Finishing runs the certified files in production; a version older than
      // the slot's current one (someone uploaded and ran a newer file since this
      // session pinned its version) would silently reload the tables from it
      const current = await currentVersions(this.deps.pool, state.definition.id)
      for (const [slotId, version] of Object.entries(resolved)) {
        const newer = current[slotId]
        if (newer && version.integrationId === state.definition.id && version.version < newer.version) {
          return {
            result: `Rejected: slot ${slotId} now reads v${newer.version} (${newer.filename}), newer than the v${version.version} this session certified. Tell the user and ask them to attach the file they want this integration to read, then run cold again.`
          }
        }
      }
      certifiedFiles = fileIds(resolved)
      if (!sameFiles(certifiedFiles, state.coldRun.files ?? {})) {
        return {
          result:
            "Rejected: the files this session reads changed since the cold run (a new attachment, or the integration's current version moved). Run run_integration with cold=true again."
        }
      }
    }
    const session = await this.deps.pool.query("SELECT user_id FROM app.agent_sessions WHERE id = $1", [sessionId])
    const prior = await this.deps.pool.query("SELECT 1 FROM app.runs WHERE integration_id = $1 LIMIT 1", [
      state.definition.id
    ])
    // Localize the catalog text: keep translations whose base text is
    // unchanged since the installed version, then fill the deployment's
    // locales in one batched call. Non-fatal - a failure installs base-only
    // text and the Settings translate action fills it later.
    try {
      const installed = await this.deps.pool.query("SELECT definition FROM app.integrations WHERE id = $1", [
        state.definition.id
      ])
      refreshChangedStrings(state.definition, installed.rows[0]?.definition ?? null)
      await translateDefinition(this.model, state.definition, await getLocales(this.deps.pool))
    } catch {
      // Base-language text still installs and renders via fallback
    }
    await installIntegration(this.deps.pool, state.definition, "ready", session.rows[0]?.user_id ?? null)
    await adoptSessionFiles(this.deps.pool, sessionId, state.definition.id)
    await cleanupScratch(this.deps.pool, this.deps.store, this.deps.workRoot, sessionId)
    // Design runs are scratch runs and never make a version current, so the
    // certified files reach production through a run pinning them: always on
    // a fresh install, and whenever a certified version differs from current
    // (otherwise the next scheduled run would read the old file with new code)
    const current = declaresFiles ? await currentVersions(this.deps.pool, state.definition.id) : {}
    const filesMoved = Object.entries(certifiedFiles).some(([slotId, versionId]) => current[slotId]?.id !== versionId)
    let load: "running" | "queued" | null = null
    if (prior.rows.length === 0 || filesMoved) {
      try {
        if (declaresFiles) {
          load = (await startPinnedRun(this.deps, state.definition.id, state.definition, certifiedFiles)).status
        } else {
          await startProductionRun(this.deps, state.definition.id)
          load = "running"
        }
      } catch {
        // The install stands; the run can still be started from the integration page
      }
    }
    const loadText =
      load === "queued"
        ? " A run reading the certified files is queued behind the run in progress; the integration page shows progress."
        : load === "running"
          ? prior.rows.length === 0
            ? " Its first data load is already running; the integration page shows progress."
            : " A run reading the certified files is already running; the integration page shows progress."
          : filesMoved
            ? " Start a run with the certified file versions from the Files section of the integration page."
            : " Data loads on its scheduled or manual runs."
    return {
      result: `Saved ${state.definition.id} as the installed integration (scratch area discarded).${loadText} ${summary}`,
      state: { ...state, firstLoadStarted: load !== null },
      finished: true
    }
  }

  /** Secret values for the draft's declared names, or an error message. */
  private async loadSecrets(state: DesignerState): Promise<Record<string, string> | string> {
    const names = state.definition.secrets ?? []
    if (names.length === 0) return {}
    if (!this.deps.secretKey) return "Error: definition declares secrets but INTEGRATOR_SECRET_KEY is not configured"
    try {
      return await getSecrets(this.deps.pool, this.deps.secretKey, state.definition.id, names)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes("is not set")) {
        return `${message}. Call request_secrets so the operator can provide it in this session; never ask for the value in chat.`
      }
      return `Error loading secrets: ${message}`
    }
  }
}
