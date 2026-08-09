import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadSkillsIndex, readSkill } from "../src/skills.js"

let skillsDir: string

before(async () => {
  skillsDir = await mkdtemp(path.join(tmpdir(), "skills-test-"))
  await mkdir(path.join(skillsDir, "chirps_source"))
  await writeFile(
    path.join(skillsDir, "chirps_source", "SKILL.md"),
    "---\nname: CHIRPS rainfall source\ndescription: How CHIRPS publishes rasters\nverified: 2026-08-09\n---\n\n# CHIRPS\n\nBody text.\n"
  )
  await mkdir(path.join(skillsDir, "bare_skill"))
  await writeFile(path.join(skillsDir, "bare_skill", "SKILL.md"), "# No frontmatter\n")
  // Ignored: invalid id, and a directory with no SKILL.md
  await mkdir(path.join(skillsDir, "Not-An-Id"))
  await writeFile(path.join(skillsDir, "Not-An-Id", "SKILL.md"), "nope")
  await mkdir(path.join(skillsDir, "empty_dir"))
})

after(async () => {
  await rm(skillsDir, { recursive: true, force: true })
})

test("loadSkillsIndex: frontmatter summaries, fallbacks, and filtering", () => {
  const index = loadSkillsIndex(skillsDir)
  assert.deepEqual(index, [
    { id: "bare_skill", name: "bare_skill", description: "" },
    { id: "chirps_source", name: "CHIRPS rainfall source", description: "How CHIRPS publishes rasters" }
  ])
})

test("loadSkillsIndex: missing directory means no skills", () => {
  assert.deepEqual(loadSkillsIndex("/nonexistent/skills"), [])
})

test("readSkill: full text, unknown ids, and malformed ids", () => {
  const text = readSkill(skillsDir, "chirps_source")
  assert.ok(text!.includes("Body text."))
  assert.ok(text!.startsWith("---\n"))
  assert.equal(readSkill(skillsDir, "no_such_skill"), null)
  assert.equal(readSkill(skillsDir, "../../etc/passwd"), null)
  assert.equal(readSkill(skillsDir, "Not-An-Id"), null)
})

test("shipped library skills parse with names and descriptions", () => {
  const shipped = loadSkillsIndex(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..", "library", "skills"))
  assert.ok(shipped.length >= 3)
  for (const skill of shipped) {
    assert.ok(skill.name.length > 0, `${skill.id} has a name`)
    assert.ok(skill.description.length > 0, `${skill.id} has a description`)
  }
})
