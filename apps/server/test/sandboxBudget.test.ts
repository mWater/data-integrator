import { test } from "node:test"
import assert from "node:assert/strict"
import { SandboxBudget } from "../src/sandboxBudget.js"
import { defaultSandboxMemoryMb } from "../src/config.js"

const tick = () => new Promise(resolve => setImmediate(resolve))

test("SandboxBudget: admits while the sum fits, queues FIFO, releases in order", async () => {
  const budget = new SandboxBudget(6000)
  const waits: string[] = []
  const releaseA = await budget.acquire(4096, r => waits.push(r))
  assert.equal(budget.inUseMb, 4096)

  let bAdmitted = false
  const b = budget.acquire(4096, r => waits.push(r)).then(release => {
    bAdmitted = true
    return release
  })
  let cAdmitted = false
  const c = budget.acquire(1024, r => waits.push(r)).then(release => {
    cAdmitted = true
    return release
  })
  await tick()
  assert.equal(bAdmitted, false, "second 4 GB job must wait")
  assert.equal(cAdmitted, false, "a small job behind a queued one keeps FIFO order")
  assert.equal(budget.queued, 2)
  assert.equal(waits.length, 2)
  assert.match(waits[0], /4096 MB requested, 4096 MB of 6000 MB in use, 0 ahead/)

  releaseA()
  const releaseB = await b
  await tick()
  assert.equal(bAdmitted, true)
  assert.equal(cAdmitted, true, "1 GB fits beside 4 GB")
  assert.equal(budget.inUseMb, 5120)

  // Releasing twice is harmless
  releaseB()
  releaseB()
  ;(await c)()
  assert.equal(budget.inUseMb, 0)
  assert.equal(budget.queued, 0)
})

test("SandboxBudget: an oversized job runs alone rather than never", async () => {
  const budget = new SandboxBudget(3000)
  const releaseSmall = await budget.acquire(1000)
  let bigAdmitted = false
  const big = budget.acquire(8192).then(release => {
    bigAdmitted = true
    return release
  })
  await tick()
  assert.equal(bigAdmitted, false)
  releaseSmall()
  const releaseBig = await big
  assert.equal(budget.inUseMb, 8192)

  let nextAdmitted = false
  const next = budget.acquire(100).then(release => {
    nextAdmitted = true
    return release
  })
  await tick()
  assert.equal(nextAdmitted, false, "nothing joins an oversized job")
  releaseBig()
  ;(await next)()
  assert.equal(budget.inUseMb, 0)
})

test("defaultSandboxMemoryMb: RAM minus the host reserve, floored at one default job", () => {
  assert.equal(defaultSandboxMemoryMb(7893), 5845)
  assert.equal(defaultSandboxMemoryMb(16000), 13952)
  assert.equal(defaultSandboxMemoryMb(3000), 2048)
})
