import { test } from "node:test"
import assert from "node:assert/strict"
import { IntegrationDefinition, SettingSpec } from "@data-integrator/definitions"
import { keepValidSettingValues, resolveSettings, settingsProblems, settingValueProblem } from "../src/integrationSettings.js"

const label = { _base: "en", en: "Label" }

const SPECS: Record<string, SettingSpec> = {
  months_back: { label, type: "integer", default: 24, min: 1, max: 120, appliesOn: "rebuild" },
  simplified: { label, type: "boolean", default: false },
  years: {
    label,
    type: "choice",
    default: "current",
    choices: [
      { value: "current", label },
      { value: "all", label }
    ]
  },
  version: { label, type: "text", default: "", pattern: "|\\d{4}-\\d{2}" }
}

function definition(extra: Partial<IntegrationDefinition>): IntegrationDefinition {
  return {
    id: "s",
    name: label,
    trigger: {},
    runtime: "python",
    destinations: [],
    code: "",
    contract: 2,
    settings: SPECS,
    ...extra
  }
}

test("settingValueProblem checks each type against its spec", () => {
  assert.equal(settingValueProblem(SPECS.months_back, 6), null)
  assert.match(settingValueProblem(SPECS.months_back, 0) ?? "", /at least 1/)
  assert.match(settingValueProblem(SPECS.months_back, 2.5) ?? "", /integer/)
  assert.match(settingValueProblem(SPECS.simplified, "yes") ?? "", /true or false/)
  assert.match(settingValueProblem(SPECS.years, "some") ?? "", /one of current, all/)
  assert.equal(settingValueProblem(SPECS.version, "2026-09"), null)
  assert.match(settingValueProblem(SPECS.version, "2026-09; drop") ?? "", /must match/)
})

test("settingsProblems: specs must be well-formed and values must be declared and valid", () => {
  assert.deepEqual(settingsProblems(definition({ settingValues: { months_back: 6, years: "all" } })), [])
  const problems = settingsProblems(
    definition({
      settings: {
        ...SPECS,
        Bad: { label, type: "integer", default: 200, min: 1, max: 120 },
        empty: { label, type: "choice", default: "x", choices: [] }
      },
      settingValues: { undeclared: 1, simplified: "no" as never }
    })
  )
  assert.ok(problems.some(p => /settings\.Bad: id must match/.test(p)))
  assert.ok(problems.some(p => /settings\.Bad\.default must be at most 120/.test(p)))
  assert.ok(problems.some(p => /settings\.empty\.choices must list at least one value/.test(p)))
  assert.ok(problems.some(p => /settingValues\.undeclared: no such setting/.test(p)))
  assert.ok(problems.some(p => /settingValues\.simplified must be true or false/.test(p)))
})

test("resolveSettings fills defaults and passes only declared settings", () => {
  const resolved = resolveSettings(definition({ settingValues: { months_back: 6, stray: 1 } as never }))
  assert.deepEqual(resolved, { months_back: 6, simplified: false, years: "current", version: "" })
  assert.deepEqual(resolveSettings(definition({ settings: undefined })), {})
})

test("keepValidSettingValues keeps the choices a new spec still accepts", () => {
  const narrower: Record<string, SettingSpec> = { months_back: { ...SPECS.months_back, max: 12 }, simplified: SPECS.simplified }
  assert.deepEqual(keepValidSettingValues({ months_back: 24, simplified: true, years: "all" }, narrower), { simplified: true })
})
