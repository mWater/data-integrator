import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

/** One standardized design prompt from library/prompts/<id>.md. */
export interface DesignPrompt {
  /** File name without .md */
  id: string
  /** The verbatim text given to the designer */
  prompt: string
  /** Scope notes: the operator's intent behind the prompt */
  scope: string
  /** Acceptance checks a reviewer runs against the ingested data */
  acceptance: string
}

/** Body of one "## Heading" section, up to the next "## ". */
function section(markdown: string, heading: string): string {
  const match = markdown.match(new RegExp(`^## ${heading}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"))
  return match ? match[1].trim() : ""
}

/** Parses one prompt file; throws when it lacks a Prompt section. */
export function parsePromptFile(id: string, markdown: string): DesignPrompt {
  // The prompt is a blockquote; unquote it and rejoin wrapped lines into paragraphs
  const prompt = section(markdown, "Prompt")
    .split("\n")
    .map(line => line.replace(/^>\s?/, ""))
    .join("\n")
    .replace(/([^\n])\n(?=[^\n])/g, "$1 ")
    .trim()
  if (!prompt) throw new Error(`${id}.md has no "## Prompt" section`)
  return { id, prompt, scope: section(markdown, "Scope"), acceptance: section(markdown, "Acceptance(?: checks)?") }
}

/** Loads the named prompts (or every prompt for "all") from a prompts directory. */
export async function loadPrompts(dir: string, ids: string[] | "all"): Promise<DesignPrompt[]> {
  const available = (await readdir(dir)).filter(f => f.endsWith(".md") && f !== "README.md").map(f => f.slice(0, -3))
  const wanted = ids === "all" ? available.sort() : ids
  const unknown = wanted.filter(id => !available.includes(id))
  if (unknown.length > 0) throw new Error(`Unknown prompts: ${unknown.join(", ")} (have: ${available.sort().join(", ")})`)
  return Promise.all(wanted.map(async id => parsePromptFile(id, await readFile(path.join(dir, `${id}.md`), "utf8"))))
}
