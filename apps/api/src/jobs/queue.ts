/**
 * Job queue abstraction. Production: pg-boss on the same Postgres (no Redis).
 * Tests and simulations: InlineQueue, which runs jobs in-process against a controllable clock.
 */
import type { Clock } from "../clock";

export type JobHandler<T = any> = (data: T) => Promise<void>;

export interface JobQueue {
  send<T>(name: string, data: T, opts?: { delayMs?: number; singletonKey?: string }): Promise<void>;
  work<T>(name: string, handler: JobHandler<T>): Promise<void>;
  /** Recurring job (pg-boss cron). */
  schedule(name: string, cron: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface PendingJob {
  name: string;
  data: unknown;
  runAt: number;
  seq: number;
}

export class InlineQueue implements JobQueue {
  private handlers = new Map<string, JobHandler>();
  private jobs: PendingJob[] = [];
  private seq = 0;
  private running: Promise<void> = Promise.resolve();
  public errors: { name: string; error: unknown }[] = [];
  /** When true, immediate jobs run automatically (dev server). Tests call drain(). */
  constructor(private clock: Clock, private opts: { autoRun?: boolean } = {}) {}

  async send<T>(name: string, data: T, opts: { delayMs?: number } = {}) {
    this.jobs.push({ name, data, runAt: this.clock.now().getTime() + (opts.delayMs ?? 0), seq: this.seq++ });
    if (this.opts.autoRun) {
      this.running = this.running.then(async () => { await this.drain(); });
      if (opts.delayMs) setTimeout(() => void this.drain(), opts.delayMs + 5).unref?.();
    }
  }
  async work<T>(name: string, handler: JobHandler<T>) {
    this.handlers.set(name, handler as JobHandler);
  }
  async schedule() {}
  async start() {}
  async stop() {}

  /** Run every job that is due now, including jobs those jobs enqueue. */
  async drain(): Promise<number> {
    let ran = 0;
    for (;;) {
      const now = this.clock.now().getTime();
      const due = this.jobs.filter((j) => j.runAt <= now).sort((a, b) => a.runAt - b.runAt || a.seq - b.seq);
      if (due.length === 0) return ran;
      const job = due[0]!;
      this.jobs = this.jobs.filter((j) => j !== job);
      const h = this.handlers.get(job.name);
      if (!h) throw new Error(`No handler for job ${job.name}`);
      try {
        await h(job.data);
      } catch (error) {
        this.errors.push({ name: job.name, error });
      }
      ran++;
    }
  }

  pending(name?: string) {
    return this.jobs.filter((j) => !name || j.name === name);
  }
}

export async function createPgBossQueue(url: string): Promise<JobQueue> {
  const { default: PgBoss } = await import("pg-boss");
  const boss = new PgBoss({ connectionString: url });
  const created = new Set<string>();
  const ensure = async (name: string) => {
    if (created.has(name)) return;
    await boss.createQueue(name);
    created.add(name);
  };
  return {
    async send(name, data, opts = {}) {
      await ensure(name);
      await boss.send(name, data as object, {
        startAfter: opts.delayMs ? Math.ceil(opts.delayMs / 1000) : undefined,
        singletonKey: opts.singletonKey,
        retryLimit: 3,
        retryDelay: 5,
      });
    },
    async work(name, handler) {
      await ensure(name);
      await boss.work(name, async (jobs) => {
        for (const j of jobs) await handler(j.data as never);
      });
    },
    async schedule(name, cron) {
      await ensure(name);
      await boss.schedule(name, cron, {}, { tz: "Africa/Nairobi" });
    },
    async start() {
      await boss.start();
    },
    async stop() {
      await boss.stop();
    },
  };
}
