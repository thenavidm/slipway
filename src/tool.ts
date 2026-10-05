/**
 * The one definition both surfaces read.
 *
 * A tool is described once: its name, what it is for, the shape of its input,
 * how risky it is and what it does. The MCP server and the CLI are both
 * generated from that object, so a tool added today is a command today, and
 * neither surface can describe it differently from the other.
 */

import type { Icon } from "@modelcontextprotocol/server";
import { isBackground, MAX_WAIT_SECONDS, waitSecondsFor, type JobDefinition } from "./jobs.js";
import type { Secrets } from "./redact.js";
import { phrase } from "./util.js";
import {
  advertised,
  CONTROL_NAMES,
  emptyInput,
  inputJsonSchema,
  propertyNames,
  isSchema,
  withControls,
  type InferInput,
  type InferOutput,
  type JsonSchema,
  type Schema,
} from "./schema.js";

/**
 * How much a call can change.
 *
 * - `read` changes nothing.
 * - `write` changes something that is easy to undo: a like, a label, a draft.
 * - `destructive` is public the moment it runs, cannot be undone, or both.
 */
export type Risk = "read" | "write" | "destructive";

export type Surface = "mcp" | "cli";

export type Logger = {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
};

/** What Slipway hands every handler, next to the app's own context. */
export type RunContext = {
  /** Aborts when the client cancels, the call times out, or Ctrl-C reaches the CLI. Pass it to fetch. */
  readonly signal: AbortSignal;
  readonly surface: Surface;
  /** The environment this call runs with: the one `context(env)` was built from. */
  readonly env: NodeJS.ProcessEnv;
  /** True when the CLI ran with --dry-run. Handlers only see it through `preview`. */
  readonly dryRun: boolean;
  readonly tool: { readonly name: string; readonly risk: Risk };
  /** Register credentials here and they are masked in every result and error. */
  readonly secrets: Secrets;
  /** Writes to stderr. stdout is the protocol channel on stdio, so nothing may print there. */
  readonly log: Logger;
  /** Report progress. Sent to an MCP client that asked for it, shown on stderr in a terminal. */
  progress(progress: number, total?: number, message?: string): Promise<void>;
};

export type ToolContext<Ctx> = Ctx & RunContext;

export type ToolExample = {
  /** What the example does, in the words a person would use to ask for it. */
  description: string;
  /** Arguments, exactly as an MCP client would send them. Validated by `slipway check`. */
  args: Record<string, unknown>;
};

/**
 * How a cursor-paginated tool pages, so the CLI can follow every page with
 * `--all` instead of leaving the loop to a script or a model.
 */
export type Paginate = {
  /** The input argument that takes the cursor. */
  cursorArg: string;
  /** Dotted path to the next cursor in a result. Empty or missing means the last page. */
  nextCursor: string;
  /** Dotted path to the array of items in a result. */
  items: string;
  /** The input argument for page size, set to the largest page when following every page. */
  limitArg?: string;
  /** The largest page the API serves. */
  maxLimit?: number;
};

/** Keep results of a read on this machine for a while, so asking twice costs one call. */
export type CacheOptions = {
  /** How long a result stays fresh, in seconds. Any write through the same app clears it sooner. */
  ttlSeconds: number;
};

/** Copy every item a list tool returns into local data, where it can be searched offline. */
export type SyncOptions = {
  /** Dotted path to each item's id: `id`, `uri`, `user.id`. */
  id: string;
  /** Dotted path to the list in a result. Defaults to the `paginate.items` path. */
  items?: string;
};

type Returns<O> = O extends Schema ? InferInput<O> : unknown;

export type ToolDefinition<Ctx, I extends Schema, O extends Schema | undefined> = {
  /** snake_case. The MCP tool name; the CLI command is the same name with dashes. */
  name: string;
  /**
   * The CLI command, when the name with dashes is taken: a tool named `doctor`
   * keeps that name over MCP, where clients know it, and the CLI's own `doctor`
   * would otherwise hide it.
   */
  command?: string;
  /** A few words for pickers and the command list: "Delete a post". */
  title: string;
  /** What it does and when to reach for it. The only documentation a model reads before calling. */
  description: string;
  /** A Zod object, or `jsonSchema({...})` for a tool generated from an API contract. */
  input?: I;
  /** Declare it and results are validated and sent as typed `structuredContent`. */
  output?: O;
  risk: Risk;
  /** Calling twice has the same effect as once. Defaults to true for reads. */
  idempotent?: boolean;
  /** Reaches outside this machine. Defaults to true; set false for local helpers. */
  openWorld?: boolean;
  /**
   * Require `confirm: true` (MCP) or `--confirm` (CLI). Defaults to true for
   * destructive tools. Set it on a write that spends money, such as a paid
   * generation.
   */
  requireConfirm?: boolean;
  /**
   * The risk of one call, when its arguments decide it: publishing is
   * destructive, saving a draft is a write. `risk` stays the highest a call can
   * be, which is what clients see in annotations and listings. The guard, the
   * confirmation and the audit log go by this, and with it only a destructive
   * call needs confirming.
   */
  riskFor?: (args: InferOutput<I>) => Risk;
  /**
   * What `<PREFIX>_READ_ONLY=1` does with this write: `hide` it, the default,
   * or keep it for `reads`, the calls `riskFor` puts at `read`, and refuse
   * every other call. For a raw API tool, whose GET only reads.
   */
  whenReadOnly?: "hide" | "reads";
  /**
   * The call spends money or credits: a paid generation, a billed send. It
   * needs confirming, `<PREFIX>_ALLOW_DESTRUCTIVE=0` refuses it, and the CLI
   * marks it `$`, while clients still see a plain write, because making an
   * image destroys nothing.
   */
  spends?: boolean;
  /**
   * What a confirmed call does that cannot be taken back, as the refusal and
   * the approval form put it: "moves money and cannot be undone". Defaults to
   * "is public or cannot be undone" for a destructive tool.
   */
  consequence?: string;
  /** Toolsets this tool belongs to. A tool with no tags is always on. */
  tags?: string[];
  /** One line for the audit log and the refusal message: "post 'Hello' as @alice". */
  summary?: (args: InferOutput<I>) => string;
  /**
   * What the person approving a call reads under the summary, when it should
   * say more than the audit log may keep: the words of a private message about
   * to be sent. Only the approval form shows it; the audit log and the
   * refusal keep to the summary.
   */
  detail?: (args: InferOutput<I>) => string;
  /** What --dry-run prints instead of running. Defaults to the validated arguments. */
  preview?: (args: InferOutput<I>, ctx: ToolContext<Ctx>) => unknown;
  examples?: ToolExample[];
  /** Input names that may be given as bare words on the command line, in order. */
  positional?: string[];
  /** Abort the call after this long. */
  timeoutMs?: number;
  /** Results this tool returns are legitimately large. Raises Claude Code's limit for this tool. */
  maxResultChars?: number;
  icons?: Icon[];
  /** Extra `_meta` for the tool's `tools/list` entry. */
  meta?: Record<string, unknown>;
  paginate?: Paginate;
  /**
   * The tool starts work that outlasts one call. Slipway adds `wait_seconds`,
   * waits that long, and generates `<name>_status` to check on the job later.
   * Describe a job the service runs with `id`, `status` and `done`, or pass
   * `{ background: true }` for a handler that is slow on its own.
   */
  job?: JobDefinition<Ctx>;
  /** Cache this read's results locally. Only for reads whose results can be a little stale. */
  cache?: CacheOptions;
  /** This read lists records worth keeping locally: `data sync` copies every page, `data search` finds them. */
  sync?: SyncOptions;
  /** Text for the result, when JSON is not the best way to read it. With `output` declared, the data also goes out as `structuredContent`. */
  render?: (result: Returns<O>) => string;
  handler: (args: InferOutput<I>, ctx: ToolContext<Ctx>) => Returns<O> | Promise<Returns<O>>;
};

export type Tool<Ctx = any> = {
  readonly kind: "slipway.tool";
  readonly name: string;
  /** The CLI command: the name with dashes. */
  readonly command: string;
  readonly title: string;
  readonly description: string;
  readonly risk: Risk;
  readonly idempotent: boolean;
  readonly openWorld: boolean;
  readonly requireConfirm: boolean;
  /** The call spends money or credits. */
  readonly spends: boolean;
  /** The risk of one call, from its arguments. `forCall` applies it. */
  readonly riskFor?: (args: any) => Risk;
  /** Read-only mode keeps this write for the calls `riskFor` puts at `read`. */
  readonly whenReadOnly?: "reads";
  /** What a confirmed call does that cannot be taken back, in the tool's own words. */
  readonly consequence?: string;
  readonly tags: readonly string[];
  readonly examples: readonly ToolExample[];
  readonly positional: readonly string[];
  readonly timeoutMs?: number;
  readonly maxResultChars?: number;
  readonly icons?: Icon[];
  readonly meta?: Record<string, unknown>;
  readonly paginate?: Paginate;
  readonly job?: JobDefinition<Ctx>;
  readonly cache?: CacheOptions;
  /** The sync settings, with `items` always filled in. */
  readonly sync?: Required<SyncOptions>;
  /** On the status tool Slipway generates for a job tool: the job tool's name. */
  readonly statusOf?: string;
  /** The author's input schema. */
  readonly input: Schema;
  /** What clients see: the input plus `confirm` when the tool requires it. */
  readonly schema: Schema;
  readonly output?: Schema;
  readonly summary?: (args: any) => string;
  /** What the person approving a call reads under the summary. Never logged. */
  readonly detail?: (args: any) => string;
  readonly preview?: (args: any, ctx: ToolContext<Ctx>) => unknown;
  readonly render?: (result: any) => string;
  readonly handler: (args: any, ctx: ToolContext<Ctx>) => unknown;
  /** The names of the advertised input's arguments, `confirm` and `wait_seconds` included when the tool takes them. */
  readonly argumentNames: readonly string[];
  /** The advertised input as JSON Schema, computed on first use and kept. */
  readonly jsonSchema: JsonSchema;
};

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const TAG = /^[a-z0-9][a-z0-9-]*$/;

/** Define a tool. Throws at load time on a definition that cannot work, not on the first call. */
export function defineTool<Ctx = unknown, I extends Schema = Schema<Record<string, never>>, O extends Schema | undefined = undefined>(
  definition: ToolDefinition<Ctx, I, O>,
): Tool<Ctx> {
  const where = `Tool '${definition.name}'`;
  if (!NAME.test(definition.name ?? "")) {
    throw new Error(`${where}: names are snake_case, start with a letter and are at most 64 characters.`);
  }
  if (!definition.title?.trim()) throw new Error(`${where}: title is required.`);
  if (!definition.description?.trim()) throw new Error(`${where}: description is required.`);
  if (!["read", "write", "destructive"].includes(definition.risk)) {
    throw new Error(`${where}: risk must be read, write or destructive.`);
  }
  if (definition.input !== undefined && !isSchema(definition.input)) {
    throw new Error(`${where}: input must be a Zod object or jsonSchema({...}).`);
  }
  if (definition.output !== undefined && !isSchema(definition.output)) {
    throw new Error(`${where}: output must be a Zod schema or jsonSchema({...}).`);
  }
  for (const tag of definition.tags ?? []) {
    if (!TAG.test(tag)) throw new Error(`${where}: tag '${tag}' must be lowercase words joined by dashes.`);
  }
  if (typeof definition.handler !== "function") throw new Error(`${where}: handler is required.`);
  if (definition.detail !== undefined && typeof definition.detail !== "function") throw new Error(`${where}: detail must be a function of the arguments.`);
  if (definition.command !== undefined && !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(definition.command)) {
    throw new Error(`${where}: command '${definition.command}' must be lowercase words joined by dashes.`);
  }
  if (definition.spends && definition.risk === "read") throw new Error(`${where}: a read cannot spend; make it a write.`);
  if (definition.riskFor !== undefined) {
    if (typeof definition.riskFor !== "function") throw new Error(`${where}: riskFor must be a function of the arguments.`);
    if (definition.risk === "read") throw new Error(`${where}: riskFor is for a write whose arguments decide how far it reaches; a read has nothing to decide.`);
  }
  if (definition.whenReadOnly !== undefined && definition.whenReadOnly !== "hide" && definition.whenReadOnly !== "reads") {
    throw new Error(`${where}: whenReadOnly is "hide" or "reads".`);
  }
  if (definition.whenReadOnly === "reads" && !definition.riskFor) {
    throw new Error(`${where}: whenReadOnly "reads" keeps the calls riskFor puts at read, so it needs riskFor.`);
  }
  const job = definition.job;
  if (job) {
    if (definition.name.length > 57) throw new Error(`${where}: a job tool's name is at most 57 characters, so its status tool fits in 64.`);
    if (!isBackground(job)) {
      const ok = (typeof job.id === "string" && job.id.length > 0) || typeof job.id === "function";
      if (!ok || typeof job.status !== "function" || typeof job.done !== "function") {
        throw new Error(`${where}: job needs id, status and done for a job the service runs, or { background: true }.`);
      }
    }
    if (job.waitSeconds !== undefined && !(job.waitSeconds >= 0 && job.waitSeconds <= MAX_WAIT_SECONDS)) {
      throw new Error(`${where}: job.waitSeconds must be 0-${MAX_WAIT_SECONDS}. Clients stop waiting on a call after about a minute.`);
    }
    if (definition.paginate) throw new Error(`${where}: a job tool cannot also page.`);
    if (definition.cache || definition.sync) throw new Error(`${where}: a job tool cannot be cached or synced.`);
  }
  if (definition.cache) {
    if (definition.risk !== "read") throw new Error(`${where}: only reads can be cached. A write must reach the service every time.`);
    if (!(typeof definition.cache.ttlSeconds === "number" && definition.cache.ttlSeconds > 0)) throw new Error(`${where}: cache.ttlSeconds must be a positive number.`);
  }
  let sync: Required<SyncOptions> | undefined;
  if (definition.sync) {
    if (definition.risk !== "read") throw new Error(`${where}: only reads can be synced.`);
    const items = definition.sync.items ?? definition.paginate?.items;
    if (!definition.sync.id || !items) throw new Error(`${where}: sync needs id, and items unless the tool pages.`);
    sync = { id: definition.sync.id, items };
  }

  const input = advertised((definition.input ?? emptyInput()) as Schema);
  const own = propertyNames((definition.input ?? emptyInput()) as Schema);
  for (const name of CONTROL_NAMES) {
    if (own.includes(name)) throw new Error(`${where}: '${name}' is Slipway's own argument. Rename the input property.`);
  }
  const requireConfirm = definition.requireConfirm ?? (definition.risk === "destructive" || definition.spends === true);
  const schema = withControls(input, {
    confirm: requireConfirm,
    ...(job ? { wait: { defaultSeconds: waitSecondsFor(job), maxSeconds: MAX_WAIT_SECONDS } } : {}),
  }) as Schema;
  let jsonSchema: JsonSchema | undefined;
  // What withControls adds, so no JSON Schema is needed to know the names.
  const properties = [...own, ...(requireConfirm ? ["confirm"] : []), ...(job ? ["wait_seconds"] : [])];
  for (const name of definition.positional ?? []) {
    if (!properties.includes(name)) throw new Error(`${where}: positional '${name}' is not an input property.`);
  }
  if (definition.paginate && !properties.includes(definition.paginate.cursorArg)) {
    throw new Error(`${where}: paginate.cursorArg '${definition.paginate.cursorArg}' is not an input property.`);
  }

  return Object.freeze({
    kind: "slipway.tool" as const,
    name: definition.name,
    command: definition.command ?? definition.name.replace(/_/g, "-"),
    title: definition.title.trim(),
    description: definition.description.trim(),
    risk: definition.risk,
    idempotent: definition.idempotent ?? definition.risk === "read",
    openWorld: definition.openWorld ?? true,
    requireConfirm,
    spends: definition.spends === true,
    ...(definition.riskFor ? { riskFor: definition.riskFor as (args: any) => Risk } : {}),
    ...(definition.whenReadOnly === "reads" ? { whenReadOnly: "reads" as const } : {}),
    ...(definition.consequence?.trim() ? { consequence: definition.consequence.trim().replace(/\.$/, "") } : {}),
    tags: Object.freeze([...(definition.tags ?? [])]),
    examples: Object.freeze([...(definition.examples ?? [])]),
    positional: Object.freeze([...(definition.positional ?? [])]),
    timeoutMs: definition.timeoutMs,
    maxResultChars: definition.maxResultChars,
    icons: definition.icons,
    meta: definition.meta,
    paginate: definition.paginate,
    ...(job ? { job } : {}),
    ...(definition.cache ? { cache: { ttlSeconds: definition.cache.ttlSeconds } } : {}),
    ...(sync ? { sync } : {}),
    input,
    schema,
    output: definition.output ? advertised(definition.output as Schema) : undefined,
    summary: definition.summary as ((args: any) => string) | undefined,
    ...(definition.detail ? { detail: definition.detail as (args: any) => string } : {}),
    preview: definition.preview as Tool<Ctx>["preview"],
    render: definition.render as ((result: any) => string) | undefined,
    handler: definition.handler as Tool<Ctx>["handler"],
    argumentNames: Object.freeze(properties),
    // Converted when something asks: the SDK lists tools from `schema`, so a server answers
    // `initialize` without converting every tool, and a command converts only its own.
    get jsonSchema(): JsonSchema {
      return (jsonSchema ??= inputJsonSchema(schema));
    },
  });
}

/**
 * Bind `defineTool` to an app's context type once, so every handler in the
 * repo gets `ctx.client` typed without repeating the generic:
 *
 *     export const { defineTool } = toolkit<Context>();
 */
export function toolkit<Ctx>() {
  return {
    defineTool: <I extends Schema = Schema<Record<string, never>>, O extends Schema | undefined = undefined>(
      definition: ToolDefinition<Ctx, I, O>,
    ): Tool<Ctx> => defineTool<Ctx, I, O>(definition),
  };
}

export function isTool(value: unknown): value is Tool {
  return (value as Tool | undefined)?.kind === "slipway.tool";
}

/**
 * One line saying what a call is about to do, for refusals, approval forms and
 * the audit log. The tool's own `summary`, or its title as a phrase: "delete a
 * note". A summary that throws falls back too, because it runs before the
 * arguments have been anywhere near the handler.
 */
export function summarize(tool: Pick<Tool, "summary" | "title">, args: Record<string, unknown>): string {
  const fallback = phrase(tool.title);
  try {
    return tool.summary?.(args)?.trim() || fallback;
  } catch {
    return fallback;
  }
}

/** The approval form's words under the summary for one call, or nothing when the tool has none or they fail. */
export function detailOf(tool: Pick<Tool, "detail">, args: Record<string, unknown>): string | undefined {
  try {
    return tool.detail?.(args)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

const REACH: Record<Risk, number> = { read: 0, write: 1, destructive: 2 };

/**
 * The tool as one call sees it. With `riskFor`, the call's risk comes from its
 * arguments, never above the declared one, and only a destructive call needs
 * confirming. Like `summarize`, it runs before validation, so a `riskFor` that
 * throws on odd arguments counts as the declared risk.
 */
export function forCall<Ctx>(tool: Tool<Ctx>, args: Record<string, unknown>): Tool<Ctx> {
  if (!tool.riskFor) return tool;
  let risk: Risk = tool.risk;
  try {
    const asked = tool.riskFor(args);
    if (asked in REACH && REACH[asked] < REACH[tool.risk]) risk = asked;
  } catch {
    // The declared risk is the safe answer.
  }
  if (risk === tool.risk) return tool;
  return { ...tool, risk, requireConfirm: tool.requireConfirm && (risk === "destructive" || tool.spends) };
}
