/**
 * Skills: reusable source and technique know-how the design agent loads on
 * demand. A skill is library/skills/<id>/SKILL.md — frontmatter (name,
 * description, verified) then freeform markdown: protocols, file layouts,
 * quirks, working snippets. The agent sees an index of one-liners in its
 * system prompt and reads full text through the read_skill tool; nothing is
 * executed, so skills carry no sandbox implications. Authored in git; the
 * library repo's review is the trust boundary.
 */

import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

/** Skill directory names: same published-identifier rule as definition ids. */
const SKILL_ID_PATTERN = /^[a-z][a-z0-9_]{0,62}$/

/** Leading `---` fenced frontmatter block of a SKILL.md. */
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/

/** The skills directory of a library root: where the layout is decided. */
export function skillsDir(libraryPath: string): string {
  return path.join(libraryPath, "skills")
}

/** One skill's index entry, from its frontmatter. */
export interface SkillSummary {
  /** Directory name under library/skills */
  id: string
  /** Display name */
  name: string
  /** One-liner shown in the agent's index; what makes on-demand loading work */
  description: string
  /** Date the skill was last checked against the live source, when recorded */
  verified: string | null
}

/** One skill's readable content: its index entry plus the prose. */
export interface SkillDetail extends SkillSummary {
  /** Markdown body with the frontmatter block removed */
  body: string
}

/**
 * Parses the frontmatter block of a SKILL.md: `key: value` lines between
 * leading `---` fences. Returns {} when there is no block.
 */
function parseFrontmatter(text: string): Record<string, string> {
  const match = text.match(FRONTMATTER)
  if (!match) return {}
  const fields: Record<string, string> = {}
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":")
    if (colon > 0) fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
  }
  return fields
}

/**
 * The skills index: one entry per library/skills/<id>/SKILL.md. Returns []
 * when the directory does not exist (deployments without a skills library).
 * Synchronous by design: loaded once at agent construction.
 */
export function loadSkillsIndex(skillsDir: string): SkillSummary[] {
  let entries: string[]
  try {
    entries = readdirSync(skillsDir)
  } catch {
    return []
  }
  const skills: SkillSummary[] = []
  for (const id of entries.sort()) {
    if (!SKILL_ID_PATTERN.test(id)) continue
    const text = readSkill(skillsDir, id)
    if (text === null) continue
    const fields = parseFrontmatter(text)
    skills.push({
      id,
      name: fields.name ?? id,
      description: fields.description ?? "",
      verified: fields.verified ?? null
    })
  }
  return skills
}

/**
 * One skill ready to read: frontmatter fields split from the markdown body.
 * Null when the id is malformed or the skill does not exist.
 */
export function loadSkill(skillsDir: string, id: string): SkillDetail | null {
  const text = readSkill(skillsDir, id)
  if (text === null) return null
  const fields = parseFrontmatter(text)
  return {
    id,
    name: fields.name ?? id,
    description: fields.description ?? "",
    verified: fields.verified ?? null,
    body: text.replace(FRONTMATTER, "").trimStart()
  }
}

/**
 * Full text of one skill (frontmatter included), or null when the id is
 * malformed or the skill does not exist.
 */
export function readSkill(skillsDir: string, id: string): string | null {
  if (!SKILL_ID_PATTERN.test(id)) return null
  try {
    return readFileSync(path.join(skillsDir, id, "SKILL.md"), "utf8")
  } catch {
    return null
  }
}
