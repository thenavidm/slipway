/**
 * Work that takes longer than a client waits for one call.
 *
 * Clients stop waiting on a tool after about a minute, and some much sooner,
 * so a render, an export or a long sync cannot simply run inside the call.
 * A job tool starts the work and waits a bounded time. A job that finishes in
 * time comes back with its result, as any call would. One that does not comes
 * back as a job the caller checks with a generated `<name>_status` tool, so a
 * model never polls blind and a script never guesses at a status endpoint.
 *
 * Two kinds:
 * - the service runs the job and has its own status endpoint (`id`, `status`
 *   and `done` say how to read it), or
 * - the handler itself is slow (`background: true`), and Slipway runs it in
 *   this process and keeps its result for an hour.
 */

import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { ApiError, CanceledError, NotFoundError, RateLimitError, SlipwayError, toSlipwayError } from "./errors.js";
import type { ToolContext } from "./tool.js";

/** Progress a job reports, as MCP progress notifications carry it. */
export type JobProgress = { progress: number; total?: number; message?: string };

/** A job the service runs, with an endpoint that reports how it is going. */
export type ServiceJob<Ctx = any, S = any> = {
  /** Where the job id is in what the handler returned: a dotted path such as `id` or `job.id`, or a function. */
  id: string | ((started: any) => string | number | undefined);
  /** Read the job's current status from the service. */
  status: (id: string, ctx: ToolContext<Ctx>) => S | Promise<S>;
  /** Whether a status means the job has finished, either way. Called on what the handler returned, then on each status. */
  done: (status: S) => boolean;
  /** Whether a finished status means it failed. A failed job is reported as an error, with the status as its details. */
  failed?: (status: S) => boolean;
  /** Progress to report while a call waits, read from a status. */
  progress?: (status: S) => JobProgress | undefined;
  /** How often to check while waiting, in milliseconds. Defaults to 2000. */
  pollMs?: number;
  /** How long a call waits before handing back the job, in seconds. Defaults to 25. */
  waitSeconds?: number;
};

/** A handler that is slow on its own: Slipway runs it in the background and keeps its result. */
export type BackgroundJob = {
  background: true;
  /** How long a call waits before handing back the job, in seconds. Defaults to 25. */
  waitSeconds?: number;
};

export type JobDefinition<Ctx = any> = ServiceJob<Ctx> | BackgroundJob;

/** What a job tool and its status tool return. */
export type JobResult = {
  job_id: string;
  tool: string;
  done: boolean;
  /** The service's latest status, for a job the service runs. */
  status?: unknown;
  /** What the tool returned, for a background job that finished. */
  result?: unknown;
  /** The last progress a background job reported. */
  progress?: JobProgress;
  started_at?: string;
  finished_at?: string;
  /** How to check again, while the job is still running. */
  check?: string;
};

/** A client stops waiting on a call after about a minute, so no call waits longer than this. */
export const MAX_WAIT_SECONDS = 55;
export const DEFAULT_WAIT_SECONDS = 25;
const DEFAULT_POLL_MS = 2_000;
const MIN_POLL_MS = 250;

export function isBackground(job: JobDefinition): job is BackgroundJob {
  return (job as BackgroundJob).background === true;
}

export function waitSecondsFor(job: JobDefinition): number {
  const wanted = job.waitSeconds ?? DEFAULT_WAIT_SECONDS;
  return Math.max(0, Math.min(MAX_WAIT_SECONDS, Math.floor(wanted)));
}

export function pollMsFor(job: ServiceJob): number {
  return Math.max(MIN_POLL_MS, job.pollMs ?? DEFAULT_POLL_MS);
}

export function readJobId(job: ServiceJob, started: unknown): string | undefined {
  let value: unknown;
  if (typeof job.id === "function") value = job.id(started);
  else {
    value = started;
    for (const part of job.id.split(".").filter(Boolean)) {
      value = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
    }
  }
  return typeof value === "string" && value ? value : typeof value === "number" ? String(value) : undefined;
}

/** The longest delay a Node timer takes. Anything longer fires after 1 ms instead. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Wait until `finished` settles or `ms` passes, whichever is first. Infinity
 * waits for as long as it takes. Resolves true when it finished. A canceled
 * call stops waiting at once.
 */
export async function waitFor(finished: Promise<unknown>, ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  let settled = false;
  const done = finished.then(
    () => void (settled = true),
    () => void (settled = true),
  );
  if (ms <= 0) return settled;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<void>((resolve) => {
    if (Number.isFinite(ms)) timer = setTimeout(resolve, Math.min(ms, MAX_TIMER_MS));
    if (signal) {
      onAbort = () => resolve();
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    await Promise.race([done, stop]);
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
  if (!settled && signal?.aborted) throw new CanceledError("Stopped waiting for the job.");
  return settled;
}

/** Sleep between status checks, cut short by a canceled call. */
export async function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  try {
    await sleep(Math.min(ms, MAX_TIMER_MS), undefined, signal ? { signal } : undefined);
  } catch {
    throw new CanceledError("Stopped waiting for the job.");
  }
}

/** A failed service job, reported with the status that says why. */
export function jobFailed(tool: string, id: string, status: unknown): SlipwayError {
  return new ApiError(`${tool} job ${id} failed.`, { details: status });
}

type Entry = {
  id: string;
  tool: string;
  startedAt: number;
  finishedAt?: number;
  state: "running" | "done" | "failed";
  result?: unknown;
  error?: SlipwayError;
  progress?: JobProgress;
  /** Settles when the job finishes, either way. Never rejects. */
  finished: Promise<void>;
  /** Whoever is waiting on the job right now, to forward its progress to. */
  listener?: (progress: JobProgress) => void;
};

/**
 * Background jobs of one process.
 *
 * Bounded both ways: at most 100 run at once, and a finished job is kept for
 * an hour, so a server that runs for weeks never grows without limit. Ids are
 * random, so one caller cannot read another's job by counting.
 */
export class JobRegistry {
  private readonly jobs = new Map<string, Entry>();
  private static readonly MAX_RUNNING = 100;
  private static readonly KEEP_MS = 60 * 60_000;
  private static readonly MAX_KEPT = 500;

  start(tool: string, work: (progress: (update: JobProgress) => void) => Promise<unknown>): Entry {
    this.prune();
    const running = [...this.jobs.values()].filter((entry) => entry.state === "running").length;
    if (running >= JobRegistry.MAX_RUNNING) {
      throw new RateLimitError(`${running} background jobs are already running. Wait for some to finish.`);
    }
    const entry: Entry = { id: `job_${randomBytes(12).toString("hex")}`, tool, startedAt: Date.now(), state: "running", finished: Promise.resolve() };
    const report = (update: JobProgress) => {
      entry.progress = update;
      entry.listener?.(update);
    };
    entry.finished = (async () => {
      try {
        entry.result = await work(report);
        entry.state = "done";
      } catch (error) {
        entry.error = toSlipwayError(error);
        entry.state = "failed";
      } finally {
        entry.finishedAt = Date.now();
        entry.listener = undefined;
      }
    })();
    this.jobs.set(entry.id, entry);
    return entry;
  }

  get(id: string, tool: string): Entry {
    this.prune();
    const entry = this.jobs.get(id);
    if (!entry || entry.tool !== tool) {
      throw new NotFoundError(`No ${tool} job ${id} in this server.`, {
        hint: "Background jobs live in the server that started them, for an hour after they finish. Start it again if the server restarted.",
      });
    }
    return entry;
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, entry] of this.jobs) {
      if (entry.finishedAt !== undefined && now - entry.finishedAt > JobRegistry.KEEP_MS) this.jobs.delete(id);
    }
    // Oldest finished first, when there are too many to keep.
    if (this.jobs.size > JobRegistry.MAX_KEPT) {
      for (const [id, entry] of this.jobs) {
        if (this.jobs.size <= JobRegistry.MAX_KEPT) break;
        if (entry.state !== "running") this.jobs.delete(id);
      }
    }
  }
}

export type BackgroundEntry = Entry;

/** A background job as its caller sees it. Throws the job's own error once it failed. */
export function backgroundResult(entry: Entry, check: string): JobResult {
  if (entry.state === "failed") throw entry.error!;
  const done = entry.state === "done";
  return {
    job_id: entry.id,
    tool: entry.tool,
    done,
    ...(done ? { result: entry.result } : {}),
    ...(entry.progress ? { progress: entry.progress } : {}),
    started_at: new Date(entry.startedAt).toISOString(),
    ...(entry.finishedAt !== undefined ? { finished_at: new Date(entry.finishedAt).toISOString() } : {}),
    ...(done ? {} : { check }),
  };
}

/** Everything one job call needs from the app that runs it. */
export type JobCall = {
  /** The job tool's name, and the job it defines. */
  jobTool: string;
  job: JobDefinition;
  /** Start a new job by running the tool's handler with a context, or check the job with this id. */
  start?: (ctx: ToolContext<any>) => unknown;
  jobId?: string;
  /** How long this call waits for the job to finish. Infinity waits to the end. */
  waitMs: number;
  /** The caller canceled: stop waiting. */
  waitSignal?: AbortSignal;
  /** A signal for one request to the service: the caller's cancel plus the tool's timeout. */
  requestSignal: () => AbortSignal;
  /** The handler's context for one request to the service, or for a background job from start to finish. */
  context: (signal: AbortSignal, progress: (update: JobProgress) => void) => ToolContext<any>;
  /** Progress to send the caller while it waits. */
  progress: (update: JobProgress) => void;
  registry: JobRegistry;
  /** A background job's own deadline, from the tool's timeout. */
  timeoutMs?: number;
  /** How to check a job again, in the words of the surface that asked. */
  check: (id: string) => string;
  /** Race a request against its signal, so a handler that ignores it still stops being waited for. */
  untilAborted: <T>(work: Promise<T>, signal: AbortSignal) => Promise<T>;
};

/** Start or check a job, and wait for it as long as this call may. */
export async function runJob(call: JobCall): Promise<JobResult> {
  if (isBackground(call.job)) return runBackground(call);
  return runServiceJob(call, call.job);
}

async function runBackground(call: JobCall): Promise<JobResult> {
  let entry: BackgroundEntry;
  if (call.start) {
    const start = call.start;
    entry = call.registry.start(call.jobTool, (report) => {
      // The job outlives the call that started it, so it gets its own signal.
      const signal = call.timeoutMs ? AbortSignal.timeout(call.timeoutMs) : new AbortController().signal;
      return call.untilAborted(Promise.resolve(start(call.context(signal, report))), signal);
    });
  } else {
    entry = call.registry.get(call.jobId!, call.jobTool);
  }
  if (entry.progress) call.progress(entry.progress);
  entry.listener = call.progress;
  try {
    await waitFor(entry.finished, call.waitMs, call.waitSignal);
  } finally {
    if (entry.listener === call.progress) entry.listener = undefined;
  }
  return backgroundResult(entry, call.check(entry.id));
}

async function runServiceJob(call: JobCall, job: ServiceJob): Promise<JobResult> {
  const read = (id: string) => {
    const signal = call.requestSignal();
    return call.untilAborted(Promise.resolve(job.status(id, call.context(signal, call.progress))), signal);
  };

  let id: string;
  let status: unknown;
  if (call.start) {
    const signal = call.requestSignal();
    status = await call.untilAborted(Promise.resolve(call.start(call.context(signal, call.progress))), signal);
    const found = readJobId(job, status);
    if (!found) {
      throw new ApiError(`${call.jobTool} started a job but returned no job id${typeof job.id === "string" ? ` at '${job.id}'` : ""}.`, { details: status });
    }
    id = found;
  } else {
    id = call.jobId!;
    status = await read(id);
  }

  const deadline = call.waitMs === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Date.now() + call.waitMs;
  for (;;) {
    const update = job.progress?.(status);
    if (update) call.progress(update);
    if (job.done(status)) {
      if (job.failed?.(status)) throw jobFailed(call.jobTool, id, status);
      return { job_id: id, tool: call.jobTool, done: true, status };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { job_id: id, tool: call.jobTool, done: false, status, check: call.check(id) };
    await pause(Math.min(pollMsFor(job), remaining), call.waitSignal);
    status = await read(id);
  }
}
