import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"

export type Timer = {
  id: string
  session: string
  directory: string
  agent: string
  reason: string
  due: number
  state: "pending" | "dispatching" | "accepted" | "uncertain" | "cancelled"
}

export interface Host {
  idle(timer: Timer): Promise<boolean>
  wake(timer: Timer): Promise<void>
}

export class Scheduler {
  private db: Database
  private running?: Promise<void>
  private interval?: ReturnType<typeof setInterval>
  private stopped = false

  constructor(path: string, private host: Host, private now = Date.now) {
    this.db = new Database(path, { create: true })
    this.db.exec(`PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS timers (
        id TEXT PRIMARY KEY, session TEXT NOT NULL, directory TEXT NOT NULL,
        agent TEXT NOT NULL, reason TEXT NOT NULL, due INTEGER NOT NULL,
        state TEXT NOT NULL, updated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS timers_due ON timers(state, due);
      CREATE TABLE IF NOT EXISTS session_locks (
        session TEXT NOT NULL, directory TEXT NOT NULL, owner TEXT NOT NULL,
        expires INTEGER NOT NULL, PRIMARY KEY(session, directory)
      );`)
  }

  schedule(session: string, directory: string, agent: string, seconds: number, reason: string): Timer {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30 * 86400)
      throw new Error("delay_seconds must be an integer between 1 and 2592000 (30 days)")
    if (!reason.trim() || reason.length > 4000) throw new Error("reason must contain 1–4000 characters")
    const timer: Timer = {
      id: randomUUID(), session, directory, agent, reason,
      due: this.now() + seconds * 1000, state: "pending",
    }
    this.db.transaction(() => {
      const count = this.db.query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM timers WHERE session = ? AND state IN ('pending', 'dispatching')",
      ).get(session)!.n
      if (count >= 20) throw new Error("At most 20 active timers per session")
      this.db.query("INSERT INTO timers VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        timer.id, session, directory, agent, reason, timer.due, timer.state, this.now(),
      )
    }).immediate()
    return timer
  }

  list(session: string, directory: string): Timer[] {
    return this.db.query<Timer, [string, string]>(
      "SELECT * FROM timers WHERE session = ? AND directory = ? ORDER BY due DESC LIMIT 100",
    ).all(session, directory)
  }

  cancel(id: string, session: string, directory: string): boolean {
    return this.db.query(
      "UPDATE timers SET state = 'cancelled', updated = ? WHERE id = ? AND session = ? AND directory = ? AND state = 'pending'",
    ).run(this.now(), id, session, directory).changes === 1
  }

  start(): void {
    if (this.interval || this.stopped) return
    this.interval = setInterval(() => { void this.tick().catch(() => {}) }, 1000)
    this.interval.unref()
    void this.tick().catch(() => {})
  }

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.running) return this.running
    this.running = this.dispatch().finally(() => { this.running = undefined })
    return this.running
  }

  private async dispatch(): Promise<void> {
    this.db.query("DELETE FROM timers WHERE state IN ('accepted', 'cancelled') AND updated < ?")
      .run(this.now() - 30 * 86400_000)
    this.db.query("DELETE FROM timers WHERE state = 'uncertain' AND updated < ?")
      .run(this.now() - 90 * 86400_000)
    this.db.query("DELETE FROM session_locks WHERE expires <= ?").run(this.now())
    // A crashed dispatch may already have reached OpenCode. Never automatically replay it.
    this.db.query("UPDATE timers SET state = 'uncertain', updated = ? WHERE state = 'dispatching' AND updated < ?")
      .run(this.now(), this.now() - 120_000)
    const due = this.db.query<Timer, [number, number]>(
      "SELECT * FROM timers WHERE state = 'pending' AND due <= ? AND updated <= ? ORDER BY updated, due LIMIT 100",
    ).all(this.now(), this.now())
    // Bound concurrent host requests, but do not let one slow workspace serialize
    // checks for every other session in the batch.
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (!this.stopped) {
        const timer = due.shift()
        if (!timer) return
        await this.dispatchTimer(timer)
      }
    }))
  }

  private async dispatchTimer(timer: Timer): Promise<void> {
      // Rotate blocked timers out of the next batch, so old busy/deleted sessions
      // cannot starve later deadlines. updated is the next check time while pending.
      this.db.query("UPDATE timers SET updated = ? WHERE id = ? AND state = 'pending'")
        .run(this.now() + 5000, timer.id)
      const owner = randomUUID()
      const locked = this.db.query("INSERT OR IGNORE INTO session_locks VALUES (?, ?, ?, ?)")
        .run(timer.session, timer.directory, owner, this.now() + 60_000).changes
      if (!locked) return
      try {
        try {
          if (!await this.host.idle(timer) || this.stopped) return
        } catch {
          // Status/read failures are safe to retry: no prompt has been sent yet.
          return
        }
        const claimed = this.db.query(
          "UPDATE timers SET state = 'dispatching', updated = ? WHERE id = ? AND state = 'pending'",
        ).run(this.now(), timer.id).changes
        if (!claimed) return
        let state = "accepted"
        try { await this.host.wake(timer) } catch { state = "uncertain" }
        this.db.query("UPDATE timers SET state = ?, updated = ? WHERE id = ? AND state = 'dispatching'")
          .run(state, this.now(), timer.id)
      } finally {
        // Give prompt_async time to publish busy status before another worker checks.
        this.db.query("UPDATE session_locks SET expires = ? WHERE session = ? AND directory = ? AND owner = ?")
          .run(this.now() + 2000, timer.session, timer.directory, owner)
      }
  }

  async close(): Promise<void> {
    this.stopped = true
    clearInterval(this.interval)
    await this.running
    this.db.close()
  }
}
