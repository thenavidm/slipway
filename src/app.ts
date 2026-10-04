/**
 * An app: one service, its tools, and the single path every call takes.
 *
 * The MCP server and the CLI are thin. Both hand a tool and its arguments to
 * `run`, which applies visibility, the write guard, timeouts, cancellation and
 * redaction in one place. A rule added here holds on both surfaces at once,
 * which is why the two cannot drift.
 */

import { basename } from "node:path";
import type { Icon, McpServer } from "@modelcontextprotocol/server";
import {
  CanceledError,
  NotConfiguredError,
  RefusedError,
  SlipwayError,
  TimeoutError,
  UsageError,
  toSlipwayError,
} from "./errors.js";
import * as z from "zod";
import { cacheKey, dataDir, scopeOf, storeAt, type DataStore } from "./data.js";
import { Guard, type ConfirmedBy } from "./guard.js";
import { isBackground, JobRegistry, runJob, waitSecondsFor, type JobProgress, type JobResult } from "./jobs.js";
import { policyEnvNames, readPolicy, visibility, type Policy, type PolicyDefaults } from "./policy.js";
import { Secrets } from "./redact.js";
import { isContentResult } from "./result.js";
import { formatIssues, validate, type Schema } from "./schema.js";
import { buildServer } from "./server.js";
import { localDataTools } from "./sync.js";
import { defineTool, isTool, summarize, type Logger, type RunContext, type Surface, type Tool, type ToolContext } from "./tool.js";

export type ResourceDefinition<Ctx> = {
  /** A short id: "accounts". */
  name: string;
  /** A static URI: "bluesky://accounts". */
  uri: string;
  title?: string;
  description?: string;
  mimeType?: string;
  /** A string is sent as text; anything else as JSON. */
  read: (ctx: Ctx) => unknown | Promise<unknown>;
};

export type PromptDefinition<Ctx> = {
  name: string;
  title?: string;
  description?: string;
  /** A Zod object of string arguments, when the prompt takes any. */
  args?: Schema;
  /** The user message the client inserts. */
  render: (args: Record<string, string>, ctx: Ctx) => string | Promise<string>;
};

export type DoctorCheck = {
  name: string;
  ok: boolean;
  /** What was found. Never a credential. */
  detail?: string;
  /** The command or setting that fixes it. */
  fix?: string;
  /** A failed check that is advice rather than a fault. */
  warn?: boolean;
};

export type ServiceSetting = {
  env: string;
  description: string;
  /** A credential: shown as set or unset, never printed. */
  secret?: boolean;
};

export type CliIO = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Reads stdin to the end, for `--input -`. */
  stdin: () => Promise<string>;
  env: NodeJS.ProcessEnv;
  /** Whether stdout is a terminal a person is looking at. */
  isTTY: boolean;
  /** The binary name the CLI was started as, for copy-pasteable examples. */
  bin: string;
  /** The folder a project-scoped `install` writes into. Defaults to the current one. */
  cwd?: string;
};

export type AppDefinition<Ctx> = {
  /** The service slug: "bluesky". Binaries default to bluesky-mcp and bluesky-cli. */
  name: string;
  /** The display name: "Bluesky". */
  title?: string;
  version: string;
  /** One line: what this server and CLI reach. */
  description?: string;
  /**
   * Guidance a client loads with the tools. Some clients read only the start,
   * so the first 512 characters should stand on their own.
   */
  instructions?: string;
  /** Environment variable prefix. Defaults to the name in capitals: BLUESKY. */
  envPrefix?: string;
  bins?: { mcp?: string; cli?: string };
  /** The npm package that ships the binaries, so `install` can have a client start it with npx. */
  package?: string;
  /**
   * Builds what handlers need: an API client, config, accounts. Called once,
   * on the first call that needs it, so `--help` works with nothing configured.
   */
  context: (env: NodeJS.ProcessEnv) => Ctx | Promise<Ctx>;
  tools: readonly Tool<Ctx>[];
  resources?: readonly ResourceDefinition<Ctx>[];
  prompts?: readonly PromptDefinition<Ctx>[];
  /** Whether any credentials are set. False makes `doctor` exit 10 and the server warn at startup. */
  configured?: (ctx: Ctx) => boolean | Promise<boolean>;
  /** Service checks for `doctor`. `network` is true only when the person passed --network. */
  doctor?: (ctx: Ctx, options: { network: boolean }) => DoctorCheck[] | Promise<DoctorCheck[]>;
  /** How to sign in: printed instructions, or an interactive flow that returns an exit code. */
  login?: string | ((io: CliIO) => number | Promise<number>);
  /** Values to mask in every result: API keys, tokens. */
  secrets?: (ctx: Ctx) => Array<string | undefined | null>;
  /**
   * A stable id for the account a context acts as, such as a user id or a
   * handle. Local data, cached results and synced records, is kept apart per
   * account. Without it, the account is a hash of the credentials from
   * `secrets`, which changes when a key is rotated.
   */
  dataScope?: (ctx: Ctx) => string | undefined;
  /** Toolset names and what each covers, for help and `agent-context`. */
  toolsets?: Record<string, string>;
  /**
   * The service's own environment variables: credentials, endpoints, tuning.
   * Listed in help, `agent-context` and generated docs, so they are written
   * down once. A secret is reported as set or not, never by value.
   */
  settings?: readonly ServiceSetting[];
  defaults?: PolicyDefaults;
  icons?: Icon[];
  links?: { repository?: string; issues?: string; docs?: string };
};

export type InvokeOptions = {
  surface: Surface;
  /** The caller passed `confirm: true` or `--confirm`. */
  confirmed?: boolean;
  /**
   * A person already approved this exact call: in a form the client showed
   * (`person`), or in the client's own approval prompt (`client`). Only the
   * MCP surface sets it, after the approval arrived.
   */
  approvedBy?: Exclude<ConfirmedBy, "flag">;
  dryRun?: boolean;
  signal?: AbortSignal;
  /**
   * How long a job tool or a job's status tool waits for the job, in
   * milliseconds, over what `wait_seconds` asked for. The CLI's `--wait` sets
   * it to Infinity.
   */
  waitMs?: number;
  env?: NodeJS.ProcessEnv;
  onProgress?: (update: { progress: number; total?: number; message?: string }) => void | Promise<void>;
  log?: Logger;
  /** Skip the local cache for this call and store the fresh result. */
  refresh?: boolean;
  /** Told when a result came from the local cache, and how old it is. */
  onCache?: (hit: { ageSeconds: number }) => void;
};

export type DryRun = { dry_run: true; tool: string; summary: string; would_run: unknown };

export type App<Ctx = any> = {
  readonly kind: "slipway.app";
  readonly name: string;
  readonly title: string;
  readonly version: string;
  readonly description?: string;
  readonly instructions?: string;
  readonly envPrefix: string;
  readonly bins: { mcp: string; cli: string };
  readonly definition: AppDefinition<Ctx>;
  readonly allTools: readonly Tool<Ctx>[];
  readonly secrets: Secrets;
  policy(env?: NodeJS.ProcessEnv): Policy;
  /** The tools this environment exposes, on both surfaces. */
  tools(env?: NodeJS.ProcessEnv): Tool<Ctx>[];
  /** A tool by MCP name or CLI command, whether or not it is visible. */
  find(nameOrCommand: string): Tool<Ctx> | undefined;
  context(env?: NodeJS.ProcessEnv): Promise<Ctx>;
  /** Validate raw arguments, then run. The path a terminal takes. */
  invoke(nameOrCommand: string, args: unknown, options: InvokeOptions): Promise<unknown>;
  /** Validate raw arguments against a tool's schema, with the error a person or a model can fix from. */
  parse(tool: Tool<Ctx>, args: unknown): Promise<Record<string, unknown>>;
  /** Run already validated arguments. The path the MCP server takes after the SDK validated them. */
  run(tool: Tool<Ctx>, args: Record<string, unknown>, options: InvokeOptions): Promise<unknown>;
  /**
   * Everything `run` refuses before confirmation comes into it: a hidden tool,
   * read-only mode, irreversible writes switched off. Throws the same error
   * `run` would, and returns the one-line summary of the call. The MCP surface
   * calls it before asking a person to approve anything.
   */
  preflight(tool: Tool<Ctx>, args: Record<string, unknown>, options: Pick<InvokeOptions, "surface" | "env">): string;
  createServer(env?: NodeJS.ProcessEnv): McpServer;
  /** This app's local data file, opened on first use. Throws when this Node.js has no SQLite. */
  localData(env?: NodeJS.ProcessEnv): Promise<DataStore>;
  /** Which account a context's local data belongs to. */
  dataScope(ctx: Ctx): string;
  runCli(argv: string[], io?: Partial<CliIO>): Promise<number>;
  /** The entry point both binaries call. */
  main(argv?: string[]): Promise<void>;
};

const SLUG = /^[a-z][a-z0-9-]{0,40}$/;

export function stderrLogger(prefix: string, env: NodeJS.ProcessEnv): Logger {
  const debug = /^(1|true|yes)$/i.test(env[`${prefix}_DEBUG`] ?? "");
  const write = (level: string, message: string, data?: unknown) =>
    process.stderr.write(`[${prefix.toLowerCase()}] ${level} ${message}${data === undefined ? "" : ` ${JSON.stringify(data)}`}\n`);
  return {
    debug: (message, data) => {
      if (debug) write("debug", message, data);
    },
    info: (message, data) => write("info", message, data),
    warn: (message, data) => write("warn", message, data),
    error: (message, data) => write("error", message, data),
  };
}

/** Create an app. Throws at load time on duplicate tools or a name that cannot become two binaries. */
export function slipway<Ctx>(definition: AppDefinition<Ctx>): App<Ctx> {
  if (!SLUG.test(definition.name ?? "")) {
    throw new Error(`App name '${definition.name}' must be a lowercase slug, like 'bluesky' or 'google-photos'.`);
  }
  if (!definition.version) throw new Error(`App '${definition.name}': version is required.`);
  for (const tool of definition.tools) {
    if (!isTool(tool)) throw new Error(`App '${definition.name}': every entry in tools must come from defineTool.`);
  }
  // A synced list brings the tools that search and refresh local data. `app`
  // is read when they run, after it exists.
  const synced = definition.tools.filter((tool) => tool.sync);
  const local = synced.length ? localDataTools(synced, () => app) : [];
  // Each job tool brings the tool that checks on its jobs, right after it.
  const allTools = [...definition.tools, ...local].flatMap((tool) => (tool.job && !tool.statusOf ? [tool, statusToolFor(tool)] : [tool]));
  const caches = allTools.some((tool) => tool.cache);
  const seen = new Set<string>();
  for (const tool of allTools) {
    if (seen.has(tool.name)) {
      throw new Error(`App '${definition.name}': two tools are named '${tool.name}'${tool.statusOf ? `, and Slipway names the status tool of ${tool.statusOf} that` : ""}.`);
    }
    seen.add(tool.name);
  }
  const jobs = new JobRegistry();

  const envPrefix = definition.envPrefix ?? definition.name.toUpperCase().replace(/-/g, "_");
  const bins = { mcp: definition.bins?.mcp ?? `${definition.name}-mcp`, cli: definition.bins?.cli ?? `${definition.name}-cli` };
  const secrets = new Secrets();
  const contexts = new WeakMap<NodeJS.ProcessEnv, Promise<Ctx>>();
  const byName = new Map<string, Tool<Ctx>>();
  for (const tool of allTools) {
    byName.set(tool.name, tool);
    byName.set(tool.command, tool);
  }

  const app: App<Ctx> = {
    kind: "slipway.app",
    name: definition.name,
    title: definition.title ?? definition.name,
    version: definition.version,
    description: definition.description,
    instructions: definition.instructions,
    envPrefix,
    bins,
    definition,
    allTools,
    secrets,

    policy(env = process.env) {
      return readPolicy(env, envPrefix, definition.defaults);
    },

    tools(env = process.env) {
      const policy = app.policy(env);
      return allTools.filter((tool) => visibility(tool, policy).visible);
    },

    find(nameOrCommand) {
      return byName.get(nameOrCommand) ?? byName.get(nameOrCommand.replace(/-/g, "_"));
    },

    context(env = process.env) {
      let pending = contexts.get(env);
      if (!pending) {
        pending = (async () => {
          let ctx: Ctx;
          try {
            ctx = await definition.context(env);
          } catch (error) {
            // A context that cannot be built is a setup problem, so it gets the
            // setup exit code and points at doctor, whatever threw it.
            const known = error instanceof SlipwayError ? error : undefined;
            throw (
              known ??
              new NotConfiguredError((error as Error)?.message ?? String(error), {
                hint: `Run \`${bins.cli} doctor\` to see what is missing.`,
                cause: error,
              })
            );
          }
          secrets.add(...(definition.secrets?.(ctx) ?? []));
          return ctx;
        })();
        // A failed build is not cached, so fixing the environment and retrying works in a long-lived server.
        pending.catch(() => contexts.delete(env));
        contexts.set(env, pending);
      }
      return pending;
    },

    async invoke(nameOrCommand, args, options) {
      const tool = app.find(nameOrCommand);
      if (!tool) {
        throw new UsageError(`Unknown tool '${nameOrCommand}'.`, { hint: `Run \`${bins.cli}\` to list the tools.` });
      }
      return app.run(tool, await app.parse(tool, args), options);
    },

    async parse(tool, args) {
      const checked = await validate(tool.schema, args ?? {});
      if (!checked.ok) {
        throw new UsageError(`Invalid arguments for ${tool.name}: ${formatIssues(checked.issues)}`, {
          hint: `Run \`${bins.cli} ${tool.command} --help\` for what it takes.`,
          details: checked.issues,
        });
      }
      return checked.value as Record<string, unknown>;
    },

    preflight(tool, rawArgs, options) {
      const env = options.env ?? process.env;
      const policy = app.policy(env);
      assertVisible(tool, policy, envPrefix);
      const { confirm: _confirm, ...args } = rawArgs;
      const summary = summarize(tool, args);
      new Guard(policy, options.surface, envPrefix).preflight(tool, summary);
      return summary;
    },

    async run(tool, rawArgs, options) {
      const env = options.env ?? process.env;
      const policy = app.policy(env);
      assertVisible(tool, policy, envPrefix);

      // Slipway's own arguments are not the tool's, so the handler never sees them.
      const { confirm, wait_seconds: waitSeconds, ...args } = rawArgs as Record<string, unknown> & { confirm?: unknown; wait_seconds?: unknown };
      const confirmedBy: ConfirmedBy | undefined =
        options.approvedBy ?? (options.confirmed === true || confirm === true ? "flag" : undefined);
      const dryRun = options.dryRun === true;
      const summary = summarize(tool, args);
      const guard = new Guard(policy, options.surface, envPrefix);
      guard.check(tool, { confirmedBy, dryRun, summary });

      const ctx = await app.context(env);
      const timeoutMs = tool.timeoutMs ?? policy.toolTimeoutMs;
      const withDeadline = () => deadlineSignal(options.signal, timeoutMs);
      const signal = withDeadline();
      const log = options.log ?? stderrLogger(envPrefix, env);
      const callProgress = increasing(options.onProgress);
      // The app's own context stays the prototype, so a class instance keeps its
      // methods and getters, and Slipway's fields sit on top.
      const contextWith = (runSignal: AbortSignal, report: (update: JobProgress) => void): ToolContext<Ctx> => {
        const runContext: RunContext = {
          signal: runSignal,
          surface: options.surface,
          env,
          dryRun,
          tool: { name: tool.name, risk: tool.risk },
          secrets,
          log,
          async progress(progress, total, message) {
            report({ progress, ...(total === undefined ? {} : { total }), ...(message ? { message } : {}) });
          },
        };
        return Object.assign(Object.create(ctx as object), runContext) as ToolContext<Ctx>;
      };
      const toolContext = contextWith(signal, callProgress);

      if (dryRun) {
        const wouldRun = tool.preview ? await tool.preview(args, toolContext) : args;
        return { dry_run: true, tool: tool.name, summary, would_run: secrets.redactDeep(wouldRun) } satisfies DryRun;
      }

      const writes = tool.risk !== "read" || tool.requireConfirm;
      const cache = tool.cache && policy.cache ? { scope: app.dataScope(ctx), key: cacheKey(args), ttlSeconds: tool.cache.ttlSeconds } : undefined;
      if (cache && !options.refresh) {
        const hit = await quietly(log, async () => (await app.localData(env)).cacheGet(cache.scope, tool.name, cache.key));
        if (hit) {
          options.onCache?.({ ageSeconds: Math.max(0, Math.round((Date.now() - hit.storedAt) / 1000)) });
          return hit.value;
        }
      }
      // A write may change anything a cached read returned, even one that failed partway.
      const forget = async () => {
        if (writes && caches && policy.cache) await quietly(log, async () => (await app.localData(env)).cacheClear(app.dataScope(ctx)));
      };
      try {
        let result: unknown;
        const jobTool = tool.statusOf ? byName.get(tool.statusOf) : tool;
        if (jobTool?.job) {
          const statusTool = tool.statusOf ? tool : allTools.find((candidate) => candidate.statusOf === tool.name)!;
          // A background job in a terminal ends with the command, so the command waits for it.
          const waitMs =
            options.waitMs ??
            (options.surface === "cli" && isBackground(jobTool.job) ? Number.POSITIVE_INFINITY : (typeof waitSeconds === "number" ? waitSeconds : waitSecondsFor(jobTool.job)) * 1000);
          result = await runJob({
            jobTool: jobTool.name,
            job: jobTool.job,
            ...(tool.statusOf ? { jobId: String(args.job_id) } : { start: (runCtx: ToolContext<Ctx>) => jobTool.handler(args, runCtx) }),
            waitMs,
            waitSignal: options.signal,
            requestSignal: withDeadline,
            context: contextWith,
            progress: callProgress,
            registry: jobs,
            timeoutMs: jobTool.timeoutMs,
            check: (id) =>
              options.surface === "cli"
                ? `${bins.cli} ${statusTool.command} ${id} --wait`
                : policy.surface === "search"
                  ? `Call call_tool with name "${statusTool.name}" and arguments {"job_id": "${id}"} to check on it. Add wait_seconds to wait for it to finish.`
                  : `Call ${statusTool.name} with job_id "${id}" to check on it. Pass wait_seconds to wait for it to finish.`,
            untilAborted: (work, runSignal) => untilAborted(work, runSignal, timeoutMs, tool.name),
          });
        } else {
          result = await untilAborted(Promise.resolve(tool.handler(args, toolContext)), signal, timeoutMs, tool.name);
        }
        if (writes) guard.record(tool, summary, (result as JobResult | undefined)?.done === false ? "started" : "done");
        await forget();
        // Only data is cached. Images and files are fetched again.
        if (cache && !isContentResult(result)) {
          const stored = secrets.redactDeep(result);
          await quietly(log, async () => (await app.localData(env)).cachePut(cache.scope, tool.name, cache.key, stored, cache.ttlSeconds));
        }
        return result;
      } catch (error) {
        if (writes) guard.record(tool, summary, "failed");
        await forget();
        throw toSlipwayError(error);
      }
    },

    localData(env = process.env) {
      return storeAt(dataDir(definition.name, envPrefix, env));
    },

    dataScope(ctx) {
      return scopeOf(definition.secrets?.(ctx) ?? [], definition.dataScope?.(ctx));
    },

    createServer(env = process.env) {
      return buildServer(app, env);
    },

    async runCli(argv, io) {
      const { runCli } = await import("./cli/run.js");
      return runCli(app, argv, io);
    },

    async main(argv = process.argv.slice(2)) {
      const { main } = await import("./entry.js");
      await main(app, argv, basename(process.argv[1] ?? ""));
    },
  };

  return app;
}

/** Local data helps a call but never fails one: anything that goes wrong with it is a cache miss, logged for debugging. */
async function quietly<T>(log: Logger, work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    log.debug("local data unavailable", { error: (error as Error)?.message ?? String(error) });
    return undefined;
  }
}

/** The caller's cancel and the tool's deadline as one signal, new for each request so every request gets the full time. */
function deadlineSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal {
  const signals: AbortSignal[] = [];
  if (signal) signals.push(signal);
  if (timeoutMs) signals.push(AbortSignal.timeout(timeoutMs));
  return signals.length === 0 ? new AbortController().signal : signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
}

/**
 * Progress for one caller. The protocol requires each update to be larger than
 * the last, so a handler that repeats a value, or a job reporting to a second
 * caller, would otherwise get the call rejected by a strict client.
 */
function increasing(onProgress: InvokeOptions["onProgress"]): (update: JobProgress) => void {
  let last = -Infinity;
  return (update) => {
    if (!onProgress || update.progress <= last) return;
    last = update.progress;
    void Promise.resolve(onProgress(update)).catch(() => undefined);
  };
}

/** The tool that checks on a job tool's jobs. It reads, whatever the job tool does. */
function statusToolFor<Ctx>(tool: Tool<Ctx>): Tool<Ctx> {
  const input = z.object({ job_id: z.string().min(1).describe(`The job_id ${tool.name} returned.`) });
  const status = defineTool<Ctx, typeof input>({
    name: `${tool.name}_status`,
    title: `${tool.title}: status`,
    description: `Check on a job ${tool.name} started: whether it is still running, and its result once it is done. Pass wait_seconds to wait for it to finish.`,
    input,
    risk: "read",
    openWorld: tool.openWorld,
    tags: [...tool.tags],
    positional: ["job_id"],
    job: tool.job,
    examples: [],
    handler: () => {
      throw new Error(`${tool.name}_status runs through its job, never on its own.`);
    },
  });
  return Object.freeze({ ...status, statusOf: tool.name });
}

/** A hidden tool is refused with the setting that hides it, so the refusal says how to turn it on. */
function assertVisible(tool: Tool, policy: Policy, envPrefix: string): void {
  const seen = visibility(tool, policy);
  if (seen.visible) return;
  const names = policyEnvNames(envPrefix);
  if (seen.reason === "read-only") {
    throw new RefusedError(`${tool.name} is unavailable: this server is running with ${names.readOnly}=1.`, {
      hint: `Unset ${names.readOnly} to allow writes.`,
    });
  }
  throw new UsageError(`${tool.name} is in a toolset that is off: ${tool.tags.join(", ")}.`, {
    hint: `Add one of them to ${names.toolsets}, or set ${names.toolsets}=all.`,
  });
}

/**
 * Race a handler against its abort signal.
 *
 * A handler that ignores the signal cannot be stopped, but its caller can stop
 * waiting for it: a client that canceled, or a call past its deadline, gets an
 * answer now rather than when the upstream API finally gives up.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal, timeoutMs: number | undefined, name: string): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal, timeoutMs, name));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal, timeoutMs, name));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortError(signal: AbortSignal, timeoutMs: number | undefined, name: string): SlipwayError {
  const reason = signal.reason as { name?: string } | undefined;
  if (reason?.name === "TimeoutError") {
    return new TimeoutError(`${name} did not finish within ${timeoutMs} ms.`, {
      hint: "Narrow the request, or raise the tool timeout if the upstream API is genuinely slow.",
    });
  }
  return new CanceledError(`${name} was canceled.`);
}
