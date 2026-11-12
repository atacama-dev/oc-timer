# oc-timer

Persistent, one-shot wake-up tools for OpenCode, implemented as a Bun plugin.

## Install

From this directory:

```sh
bun install --frozen-lockfile
```

Add this entry to the existing `plugin` array in your OpenCode configuration
(preserve its other entries):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///home/julien/personal-project/oc-timer/src/index.ts"]
}
```

Quit and restart OpenCode (or restart its persistent server) to load the plugin.
The project does not install itself or modify your global configuration.
Requires Bun and the OpenCode plugin/SDK interface compatible with 1.18.23.

## Tools

- `wake_in({ delay_seconds: 600, reason: "Check the background job" })`:
  schedules a reminder in **this session** and returns its ID and deadline immediately.
- `wake_list({})`: returns this session's last 100 timers and their states.
- `wake_cancel({ timer_id: "<returned UUID>" })`: cancels a pending timer belonging
  to this session. Returns `cancelled: false` if already dispatched or not owned.

Scheduling requests native `wake_in` permission. This authorizes a future agent
turn and potential token usage; it does not bypass the permissions of subsequent
tool calls. Session ID, directory and agent come from trusted tool context, not
model-supplied parameters. Delay is 1 second–30 days, reason is at most 4,000
characters, and each session may have at most 20 active timers.

## Delivery and persistence

- SQLite state lives under `$XDG_STATE_HOME/oc-timer` (default
  `~/.local/state/oc-timer`), in a private directory, namespaced by server origin.
  Reminder text is stored locally in plaintext.
- The plugin polls every second. Busy/retrying sessions are deferred; failed
  status checks are retried. Sparse status maps treat omitted sessions as idle,
  after verifying that the session exists in its recorded directory.
  Checks run with bounded concurrency (eight per instance) and 15-second API
  timeouts. A large backlog or an unavailable server can delay delivery; this
  is a best-effort reminder, not a real-time scheduler.
- The wake uses the SDK's `session.promptAsync`, adding a synthetic reminder to
  the existing history with the recorded agent. It does not require an open TUI.
- Multiple plugin instances coordinate using atomic database claims and short
  per-session locks. Idle checks cannot prevent a user or another plugin from
  starting a turn at exactly the same time; there is no atomic idle-and-prompt API.
- Restarting with the **same server origin** resumes pending timers when the
  plugin is initialized. Use a stable server address/port for reliable recovery.
  Nothing wakes while OpenCode is stopped, the computer is asleep, or no plugin
  instance is loaded. Overdue timers are checked when it resumes.
- Deleted/unavailable sessions remain pending and can be cancelled; their checks
  rotate through batches so they do not starve other timers.
- `accepted` means OpenCode accepted the prompt, **not** that the agent completed
  the requested action. A network failure or interrupted dispatch is `uncertain`:
  the prompt might already have arrived, so it is never automatically replayed.
  Interrupted dispatches become uncertain after two minutes. Inspect the session
  before scheduling a replacement. This favors avoiding duplicate agent actions
  over guaranteeing delivery.
- Accepted/cancelled records expire after 30 days; uncertain records after 90
  days. Pending records persist until dispatched or cancelled.
- Timers are one-shot, not recurring jobs. An agent must explicitly schedule any
  subsequent reminder; use this carefully to avoid uncontrolled loops/costs.

## Verify

```sh
bun test
bun run typecheck
```

Tests use temporary databases and a simulated HTTP host; they do not send prompts
to a live OpenCode instance.
