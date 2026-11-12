import { tool, type Plugin } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"
import { mkdirSync, chmodSync } from "node:fs"
import { homedir } from "node:os"
import { join, isAbsolute } from "node:path"
import { Scheduler } from "./scheduler"

const OcTimer: Plugin = async ({ client, serverUrl }) => {
  const root = join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "oc-timer")
  mkdirSync(root, { recursive: true, mode: 0o700 })
  chmodSync(root, 0o700)
  const namespace = createHash("sha256").update(serverUrl.origin).digest("hex").slice(0, 24)
  const path = join(root, `${namespace}.sqlite`)
  const scheduler = new Scheduler(path, {
    async idle(timer) {
      const session = await client.session.get({ path: { id: timer.session }, query: { directory: timer.directory }, signal: AbortSignal.timeout(15_000) })
      if (session.error || session.data?.id !== timer.session || session.data.directory !== timer.directory) return false
      const status = await client.session.status({ query: { directory: timer.directory }, signal: AbortSignal.timeout(15_000) })
      if (status.error || !status.data) throw new Error("Session status unavailable")
      return !status.data[timer.session] || status.data[timer.session].type === "idle"
    },
    async wake(timer) {
      const result = await client.session.promptAsync({
        path: { id: timer.session },
        query: { directory: timer.directory },
        signal: AbortSignal.timeout(15_000),
        body: {
          agent: timer.agent,
          parts: [{ type: "text", synthetic: true, text:
            `Scheduled timer ${timer.id} is due (${new Date(timer.due).toISOString()}).\n` +
            `Reminder requested earlier in this session:\n${timer.reason}\n` +
            "Reassess this reminder against the current conversation before acting. Normal permissions still apply.",
          }],
        },
      })
      if (result.error) throw new Error("Wake not accepted")
    },
  })
  chmodSync(path, 0o600)
  scheduler.start()
  return {
    dispose: () => scheduler.close(),
    tool: {
      wake_in: tool({
        description: "Schedule a persistent one-shot reminder for this session. Returns immediately; wakes the agent after delay_seconds, once idle. OpenCode must be running. Maximum 30 days; no automatic recurring timers.",
        args: {
          delay_seconds: tool.schema.number().int().min(1).max(2592000),
          reason: tool.schema.string().min(1).max(4000),
        },
        async execute(args, context) {
          if (!isAbsolute(context.directory)) throw new Error("Absolute ToolContext.directory required")
          await context.ask({ permission: "wake_in", patterns: ["*"], always: ["*"],
            metadata: { delay_seconds: args.delay_seconds, reason: args.reason } })
          if (context.abort.aborted) throw new Error("Timer scheduling aborted")
          const session = await client.session.get({ path: { id: context.sessionID }, query: { directory: context.directory }, signal: AbortSignal.timeout(15_000) })
          if (session.error || session.data?.id !== context.sessionID || session.data.directory !== context.directory) throw new Error("Session directory could not be verified")
          if (context.abort.aborted) throw new Error("Timer scheduling aborted")
          return JSON.stringify(scheduler.schedule(context.sessionID, context.directory, context.agent, args.delay_seconds, args.reason))
        },
      }),
      wake_list: tool({
        description: "List this session's last 100 timers and their delivery states.",
        args: {},
        async execute(_, context) { return JSON.stringify(scheduler.list(context.sessionID, context.directory)) },
      }),
      wake_cancel: tool({
        description: "Cancel a pending timer owned by this session. A dispatched timer cannot be recalled.",
        args: { timer_id: tool.schema.string().uuid() },
        async execute(args, context) {
          return JSON.stringify({ cancelled: scheduler.cancel(args.timer_id, context.sessionID, context.directory) })
        },
      }),
    },
  }
}

export default OcTimer
