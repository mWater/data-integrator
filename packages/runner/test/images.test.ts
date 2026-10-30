import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { RUNTIME_IMAGE_REPOSITORY, RUNTIME_IMAGES, RUNTIME_VERSION } from "../src/images.js"

test("the stamped runtime version matches package.json", async () => {
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json")
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { version: string }
  assert.equal(RUNTIME_VERSION, pkg.version)
})

test("every runtime image is tagged with the runtime version", () => {
  for (const [id, image] of Object.entries(RUNTIME_IMAGES)) {
    assert.ok(image.startsWith(`${RUNTIME_IMAGE_REPOSITORY}-`), `${id}: ${image}`)
    assert.ok(image.endsWith(`:${RUNTIME_VERSION}`), `${id}: ${image}`)
  }
})
