import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { Scheduler, type Host, type Timer } from "../src/scheduler"

const roots: string[] = []
const schedulers: Scheduler[] = []
afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) await scheduler.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "oc-timer-test-"))
  roots.push(root)
  const path = join(root, "timers.sqlite")
  let now = 1000
  const sent: Timer[] = []
  const host: Host = { idle: async () => true, wake: async timer => { sent.push(timer) } }
  const open = () => {
    const scheduler = new Scheduler(path, host, () => now)
    schedulers.push(scheduler)
    return scheduler
  }
  const scheduler = open()
  return { scheduler, open, path, host, sent, advance: (ms = 2000) => { now += ms } }
}

test("one-shot wake runs only after the deadline", async () => {
  const f = fixture()
  const timer = f.scheduler.schedule("s", "/project", "build", 1, "Check job")
  await f.scheduler.tick()
  expect(f.sent).toHaveLength(0)
  f.advance()
  await f.scheduler.tick()
  await f.scheduler.tick()
  expect(f.sent.map(t => t.id)).toEqual([timer.id])
  expect(f.scheduler.list("s", "/project")[0].state).toBe("accepted")
})

test("pending timers survive database reopen", async () => {
  const f = fixture()
  f.scheduler.schedule("s", "/project", "build", 1, "Check job")
  await f.scheduler.close()
  schedulers.splice(schedulers.indexOf(f.scheduler), 1)
  f.advance()
  await f.open().tick()
  expect(f.sent).toHaveLength(1)
})

test("busy sessions and status failures defer without losing the timer", async () => {
  const f = fixture()
  f.scheduler.schedule("s", "/project", "build", 1, "Check job")
  f.advance()
  f.host.idle = async () => false
  await f.scheduler.tick()
  f.host.idle = async () => { throw new Error("offline") }
  f.advance(6000)
  await f.scheduler.tick()
  expect(f.sent).toHaveLength(0)
  expect(f.scheduler.list("s", "/project")[0].state).toBe("pending")
  f.host.idle = async () => true
  f.advance(6000)
  await f.scheduler.tick()
  expect(f.sent).toHaveLength(1)
})

test("list and cancellation cannot cross session/directory ownership", async () => {
  const f = fixture()
  const timer = f.scheduler.schedule("s", "/project", "build", 1, "Check job")
  expect(f.scheduler.list("other", "/project")).toEqual([])
  expect(f.scheduler.list("s", "/other")).toEqual([])
  expect(f.scheduler.cancel(timer.id, "other", "/project")).toBe(false)
  expect(f.scheduler.cancel(timer.id, "s", "/other")).toBe(false)
  expect(f.scheduler.cancel(timer.id, "s", "/project")).toBe(true)
  f.advance()
  await f.scheduler.tick()
  expect(f.sent).toHaveLength(0)
})

test("two workers atomically claim once", async () => {
  const f = fixture()
  f.scheduler.schedule("s", "/project", "build", 1, "Check job")
  const other = f.open()
  f.advance()
  await Promise.all([f.scheduler.tick(), other.tick(), f.scheduler.tick()])
  expect(f.sent).toHaveLength(1)
})

test("ambiguous prompt failures are not automatically replayed", async () => {
  const f = fixture()
  f.scheduler.schedule("s", "/project", "build", 1, "Check job")
  f.host.wake = async timer => { f.sent.push(timer); throw new Error("connection lost") }
  f.advance()
  await f.scheduler.tick()
  await f.scheduler.tick()
  expect(f.sent).toHaveLength(1)
  expect(f.scheduler.list("s", "/project")[0].state).toBe("uncertain")
})

test("crashed dispatch becomes uncertain, not pending", async () => {
  const f = fixture()
  const timer = f.scheduler.schedule("s", "/project", "build", 1, "Check job")
  const db = new Database(f.path)
  db.query("UPDATE timers SET state = 'dispatching', updated = -200000 WHERE id = ?").run(timer.id)
  db.close()
  f.advance()
  await f.scheduler.tick()
  expect(f.sent).toHaveLength(0)
  expect(f.scheduler.list("s", "/project")[0].state).toBe("uncertain")
})

test("validation and per-session active quota", () => {
  const f = fixture()
  for (const delay of [0, -1, 0.5, NaN, Infinity, 2592001])
    expect(() => f.scheduler.schedule("s", "/p", "build", delay, "reason")).toThrow()
  for (const reason of ["", "  ", "a".repeat(4001)])
    expect(() => f.scheduler.schedule("s", "/p", "build", 1, reason)).toThrow()
  for (let i = 0; i < 20; i++) f.scheduler.schedule("s", "/p", "build", 1, "reason")
  expect(() => f.scheduler.schedule("s", "/p", "build", 1, "reason")).toThrow("20")
})

test("cancellation while checking status prevents dispatch", async () => {
  const f = fixture()
  const timer = f.scheduler.schedule("s", "/p", "build", 1, "reason")
  f.host.idle = async () => { f.scheduler.cancel(timer.id, "s", "/p"); return true }
  f.advance()
  await f.scheduler.tick()
  expect(f.sent).toHaveLength(0)
})

test("blocked batches do not starve later sessions", async () => {
  const f = fixture()
  for (let i = 0; i < 101; i++) f.scheduler.schedule(`s${i}`, "/p", "build", 1, "reason")
  f.host.idle = async timer => timer.session === "s100"
  f.advance()
  await f.scheduler.tick()
  await f.scheduler.tick()
  expect(f.sent.map(t => t.session)).toEqual(["s100"])
})

test("workers do not dispatch two timers concurrently for one session", async () => {
  const f = fixture()
  f.scheduler.schedule("s", "/p", "build", 1, "first")
  f.scheduler.schedule("s", "/p", "build", 1, "second")
  const other = f.open()
  f.advance()
  await Promise.all([f.scheduler.tick(), other.tick()])
  expect(f.sent).toHaveLength(1)
  f.advance(6000)
  await other.tick()
  expect(f.sent).toHaveLength(2)
})

test("slow status checks do not serialize healthy sessions", async () => {
  const f = fixture()
  f.scheduler.schedule("slow", "/p", "build", 1, "first")
  f.scheduler.schedule("healthy", "/p", "build", 1, "second")
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  f.host.idle = async timer => {
    if (timer.session === "slow") { await blocked; throw new Error("timeout") }
    return true
  }
  f.advance()
  const tick = f.scheduler.tick()
  await Bun.sleep(1)
  try { expect(f.sent.map(t => t.session)).toEqual(["healthy"]) }
  finally { release(); await tick }
})
