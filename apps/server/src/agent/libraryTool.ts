/**
 * The library as the agents see it: one search over the deployment's
 * installable entries, shared by Explore, the dashboard builder and the designer.
 * The point is that "that data is not here" becomes "install X from the
 * Library" with a link the user can act on, or a link that opens a design
 * session with the request already written when nothing in the library fits.
 */

import pg from "pg"
import { IntegrationDefinition, LocalizedString, localizeString } from "@data-integrator/definitions"
import { listLibrary, loadLibraryEntry } from "../library.js"

/** Words too short or too common to discriminate between entries. */
const STOP_WORDS = new Set(["the", "and", "for", "with", "data", "from", "map", "layer", "table", "show", "get"])

/** Every language's text of a localized string, for matching. */
function allTexts(value: LocalizedString | string | null | undefined): string {
  if (!value) return ""
  if (typeof value === "string") return value
  return Object.entries(value)
    .filter(([k]) => k !== "_base")
    .map(([, v]) => String(v))
    .join(" ")
}

/** Query terms worth matching: lowercase words of three letters or more, minus stop words. */
function terms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(w => w.length >= 3 && !STOP_WORDS.has(w))
    )
  )
}

/** In-app link that opens the Library with the entry's install confirmation open. */
export function libraryInstallLink(id: string): string {
  return `#/library?install=${encodeURIComponent(id)}`
}

/** In-app link that opens a new design session with the request pre-written. */
export function designSessionLink(request: string): string {
  return `#/design?prompt=${encodeURIComponent(request)}`
}

/** Describes one entry's destinations with their column or band ids. */
function describeDestinations(definition: IntegrationDefinition): string {
  return (definition.destinations ?? [])
    .map(d =>
      d.kind === "table"
        ? `table ${d.tableId} (${d.columns.map(c => c.id).join(", ")})`
        : `raster layer ${d.layerId}, ${d.temporality}${d.retention ? `, keeps ${d.retention.days} days` : ""} (bands ${d.bands.map(b => b.id).join(", ")})`
    )
    .join("; ")
}

/**
 * Searches the library for entries matching a plain-language request and
 * returns a text block for the model: every hit with its status, what it
 * produces, and the link to act on it. With no hits it lists what the library
 * holds and the design-session link, so the agent never answers "go find a
 * source" when a one-click install or a pre-written design request exists.
 */
export async function searchLibrary(
  pool: pg.Pool,
  libraryPath: string | null,
  query: string,
  locale = "en"
): Promise<string> {
  if (!libraryPath) return "This deployment has no library configured."
  const entries = await listLibrary(pool, libraryPath)
  if (entries.length === 0) return "The library is empty."

  const wanted = terms(query)
  const scored: { entry: (typeof entries)[number]; definition: IntegrationDefinition; score: number }[] = []
  for (const entry of entries) {
    const definition = await loadLibraryEntry(libraryPath, entry.id)
    if (!definition) continue
    const haystack = [
      entry.id,
      allTexts(entry.name),
      allTexts(entry.description),
      allTexts(definition.source?.name),
      definition.source?.provider ?? "",
      describeDestinations(definition),
      ...(definition.destinations ?? []).flatMap(d =>
        d.kind === "table" ? d.columns.map(c => allTexts(c.name)) : d.bands.map(b => allTexts(b.name))
      )
    ]
      .join(" ")
      .toLowerCase()
    const score = wanted.filter(w => haystack.includes(w)).length
    scored.push({ entry, definition, score })
  }

  const hits = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score)
  const shown = hits.length > 0 ? hits : scored
  const heading =
    hits.length > 0
      ? `${hits.length} library ${hits.length === 1 ? "entry matches" : "entries match"} "${query}":`
      : `No library entry matches "${query}". The library holds these entries:`

  const lines = shown.map(({ entry, definition }) => {
    const name = localizeString(entry.name, locale)
    const status =
      entry.status === "installed"
        ? `installed (v${entry.installedVersion}); data page #/integration/${entry.id}`
        : entry.status === "update_available"
          ? `installed (v${entry.installedVersion}, update available); data page #/integration/${entry.id}`
          : `NOT installed; install link ${libraryInstallLink(entry.id)}`
    const about = entry.description ? ` ${localizeString(entry.description, locale)}` : ""
    const source = definition.source
      ? ` Source: ${localizeString(definition.source.name, locale)}${definition.source.provider ? `, ${definition.source.provider}` : ""}${definition.source.license ? ` (${definition.source.license})` : ""}.`
      : ""
    return `- ${entry.id} "${name}": ${status}.${about}${source} Produces: ${describeDestinations(definition)}.`
  })

  const footer =
    hits.length > 0
      ? `Installing takes one click on the install link (editors only; a viewer should ask an editor). When none of these fits, offer a design session instead: ${designSessionLink(query)}`
      : `Offer a design session with the request written: ${designSessionLink(query)}`
  return `${heading}\n${lines.join("\n")}\n\n${footer}`
}
