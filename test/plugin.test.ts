import { expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"
import { mkdtempSync, rmSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import OcTimer from "../src/index"

test("plugin permissions, trusted routing, sparse idle status and async SDK delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc-timer-plugin-"))
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = root
  const prompts: { url: URL; body: any }[] = []
  let directory = "/session-project"
  let busy = true
  let reject = false
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/session/s") return Response.json({ id: "s", directory })
      if (url.pathname === "/session/status") return Response.json(busy ? { s: { type: "busy" } } : {})
      if (url.pathname === "/session/s/prompt_async") {
        prompts.push({ url, body: await request.json() })
        return reject ? Response.json({ error: "rejected" }, { status: 500 }) : new Response(null, { status: 204 })
      }
      return new Response(null, { status: 404 })
    },
  })
  const hooks = await OcTimer({ client: createOpencodeClient({ baseUrl: server.url.href }), serverUrl: server.url } as PluginInput)
  const context: ToolContext = {
    sessionID: "s", directory: "/session-project", worktree: "/", agent: "build", messageID: "m",
    abort: new AbortController().signal, metadata() {}, ask: async () => {},
  }
  const args = { delay_seconds: 1, reason: "Check background job" }
  const makeDue = () => {
    const file = readdirSync(join(root, "oc-timer")).find(name => name.endsWith(".sqlite"))!
    const db = new Database(join(root, "oc-timer", file))
    db.query("UPDATE timers SET due = 0, updated = 0 WHERE state = 'pending'").run()
    db.query("DELETE FROM session_locks").run()
    db.close()
  }
  try {
    const wake = hooks.tool!.wake_in
    await expect(wake.execute(args, { ...context, ask: async () => { throw new Error("denied") } })).rejects.toThrow("denied")
    await expect(wake.execute(args, { ...context, abort: AbortSignal.abort() })).rejects.toThrow("aborted")
    directory = "/wrong"
    await expect(wake.execute(args, context)).rejects.toThrow("verified")
    directory = context.directory
    let asked = 0
    const timer = JSON.parse(await wake.execute(args, { ...context, ask: async () => { asked++ } }) as string)
    expect(asked).toBe(1)
    expect(timer.session).toBe("s")
    expect(timer.directory).toBe(context.directory)
    makeDue()
    await Bun.sleep(1200)
    expect(prompts).toHaveLength(0)
    busy = false
    makeDue()
    await Bun.sleep(1200)
    expect(prompts).toHaveLength(1)
    expect(prompts[0].url.searchParams.get("directory")).toBe(context.directory)
    expect(prompts[0].body.agent).toBe("build")
    expect(prompts[0].body.parts[0].synthetic).toBe(true)
    expect(prompts[0].body.parts[0].text).toContain(args.reason)
    let rows = JSON.parse(await hooks.tool!.wake_list.execute({}, context) as string)
    expect(rows[0].state).toBe("accepted")
    reject = true
    await wake.execute(args, context)
    makeDue()
    await Bun.sleep(1200)
    rows = JSON.parse(await hooks.tool!.wake_list.execute({}, context) as string)
    expect(rows.some((row: any) => row.state === "uncertain")).toBe(true)
    expect(prompts).toHaveLength(2)
  } finally {
    await hooks.dispose?.()
    server.stop(true)
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
    rmSync(root, { recursive: true })
  }
}, 10000)
