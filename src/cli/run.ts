/**
 * The CLI surface.
 *
 * Every tool is a command with the same name, the same arguments and the same
 * guard as over MCP, because both run through `app.invoke`. What this module
 * adds is what a terminal needs and a protocol does not: flags, help, output
 * shapes, exit codes, pagination and files.
 */

import { writeFileSync } from "node:fs";
import type { App, CliIO } from "../app.js";
import { runDoctor } from "../doctor.js";
import { EXIT, RefusedError, SlipwayError, UsageError, toSlipwayError } from "../errors.js";
import { eachPage } from "../pages.js";
import { visibility, policyEnvNames } from "../policy.js";
import { outputJsonSchema } from "../schema.js";
import { didYouMean, searchTools } from "../search.js";
import type { Tool } from "../tool.js";
import { completionScript } from "./completion.js";
import { agentContext } from "./context.js";
import { flagsFor, missingRequired, parseJsonValue, parseToolArgs } from "./flags.js";
import { BUILTINS, renderGeneralHelp, renderList, renderToolHelp, toolLine } from "./help.js";
import { formatOutput, type Format } from "./output.js";

type Globals = {
  format: Format;
  explicitFormat: boolean;
  agent: boolean;
  select?: string[];
  out?: string;
  input?: string;
  dryRun: boolean;
  confirm: boolean;
  wait: boolean;
  refresh: boolean;
  all: boolean;
  maxItems?: number;
  timeoutMs?: number;
  help: boolean;
  version: boolean;
};

const VALUE_FLAGS = new Set(["--select", "--out", "--input", "--max-items", "--timeout"]);
const FORMATS: Record<string, Format> = {
  "--json": "json",
  "--compact": "compact",
  "--jsonl": "jsonl",
  "--csv": "csv",
  "--tsv": "tsv",
  "--plain": "tsv",
  "--quiet": "quiet",
};
/** Accepted so scripts written for other CLIs do not break. `--yes` is accepted and never confirms anything. */
const IGNORED = new Set(["--no-color", "--no-input", "--yes"]);
const SWITCHES = new Set([...Object.keys(FORMATS), ...IGNORED, "--agent", "--dry-run", "--confirm", "--wait", "--refresh", "--all", "--help", "-h", "--version", "-v"]);

function flagOf(token: string): string {
  const eq = token.indexOf("=");
  return eq === -1 ? token : token.slice(0, eq);
}

/** The index of the command word: the first bare word that is not the value of a global flag. */
function findCommand(argv: readonly string[]): number {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") return -1;
    if (token.startsWith("-")) {
      if (VALUE_FLAGS.has(token)) i++;
      continue;
    }
    return i;
  }
  return -1;
}

/**
 * Pull the CLI's own flags out of argv. A flag the tool itself defines wins, so
 * a tool with an `input` or `select` argument keeps it.
 */
function extractGlobals(argv: readonly string[], reserved: ReadonlySet<string>): { globals: Globals; rest: string[] } {
  const globals: Globals = { format: "auto", explicitFormat: false, agent: false, dryRun: false, confirm: false, wait: false, refresh: false, all: false, help: false, version: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    const name = flagOf(token);
    if (reserved.has(name) || (!SWITCHES.has(name) && !VALUE_FLAGS.has(name))) {
      rest.push(token);
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : argv[++i];
      if (value === undefined) throw new UsageError(`${name} expects a value.`);
      if (name === "--select") globals.select = value.split(",").map((part) => part.trim()).filter(Boolean);
      else if (name === "--out") globals.out = value;
      else if (name === "--input") globals.input = value;
      else {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1) throw new UsageError(`${name} expects a positive whole number, got '${value}'.`);
        if (name === "--max-items") globals.maxItems = number;
        else globals.timeoutMs = number;
      }
      continue;
    }
    if (FORMATS[name]) {
      globals.format = FORMATS[name]!;
      globals.explicitFormat = true;
    } else if (name === "--agent") globals.agent = true;
    else if (name === "--dry-run") globals.dryRun = true;
    else if (name === "--confirm") globals.confirm = true;
    else if (name === "--wait") globals.wait = true;
    else if (name === "--refresh") globals.refresh = true;
    else if (name === "--all") globals.all = true;
    else if (name === "--help" || name === "-h") globals.help = true;
    else if (name === "--version" || name === "-v") globals.version = true;
  }
  // Agent mode means one line of JSON, unless a format was asked for by name.
  if (globals.agent && !globals.explicitFormat) globals.format = "compact";
  return { globals, rest };
}

function defaultIO(app: App, partial: Partial<CliIO>): CliIO {
  return {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    stdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    },
    env: process.env,
    isTTY: Boolean(process.stdout.isTTY),
    bin: app.bins.cli,
    ...partial,
  };
}

function emitError(io: CliIO, app: App, error: SlipwayError, agent: boolean): void {
  const payload = app.secrets.redactDeep(error.toJSON());
  io.stderr(`${agent ? JSON.stringify(payload) : JSON.stringify(payload, null, 2)}\n`);
}

export async function runCli(app: App, argv: readonly string[], partial: Partial<CliIO> = {}): Promise<number> {
  const io = defaultIO(app, partial);
  const at = findCommand(argv);
  const command = at === -1 ? undefined : argv[at]!;
  const builtin = command !== undefined && (BUILTINS as readonly string[]).includes(command);
  const custom = command !== undefined && !builtin ? app.definition.commands?.find((candidate) => candidate.name === command) : undefined;
  const tool = command !== undefined && !builtin && !custom ? app.find(command) : undefined;
  const reserved = new Set(tool ? flagsFor(tool.jsonSchema).map((flag) => flag.flag) : (custom?.flags ?? []));
  let agent = argv.includes("--agent");

  try {
    const { globals, rest } = extractGlobals(at === -1 ? argv : [...argv.slice(0, at), ...argv.slice(at + 1)], reserved);
    agent = globals.agent;

    if (command === undefined) {
      if (globals.version) return printVersion(app, io);
      if (globals.help) return print(io, renderGeneralHelp(app, io.bin));
      return print(io, renderList(app, app.tools(io.env), io.bin, io.env));
    }

    if (builtin) return await runBuiltin(app, io, command, rest, globals);
    if (custom) {
      if (globals.help) return print(io, `\nUsage: ${io.bin} ${custom.usage ?? custom.name}\n\n${sentence(custom.help)}\n`);
      return await custom.run(io, rest);
    }

    if (!tool) {
      const candidates = [...app.tools(io.env).map((t) => t.command), ...BUILTINS, ...(app.definition.commands ?? []).map((c) => c.name)];
      const guess = didYouMean(command, candidates);
      throw new UsageError(`Unknown command '${command}'.${guess ? ` Did you mean '${guess}'?` : ""}`, {
        hint: `Run \`${app.bins.cli}\` to list commands, or \`${app.bins.cli} which <words>\` to find one.`,
      });
    }

    const seen = visibility(tool, app.policy(io.env));
    if (!seen.visible && seen.reason === "destructive") {
      const names = policyEnvNames(app.envPrefix);
      throw new RefusedError(`${tool.command} is unavailable: ${names.allowDestructive}=0 hides the irreversible writes.`, {
        hint: `Unset ${names.allowDestructive} to allow them.`,
      });
    }
    if (!seen.visible) {
      const names = policyEnvNames(app.envPrefix);
      throw new UsageError(
        seen.reason === "read-only"
          ? `${tool.command} is unavailable: ${names.readOnly}=1 hides every write.`
          : `${tool.command} is in a toolset that is off: ${tool.tags.join(", ")}.`,
        { hint: seen.reason === "read-only" ? `Unset ${names.readOnly} to allow writes.` : `Add one of them to ${names.toolsets}, or set ${names.toolsets}=all.` },
      );
    }

    if (globals.help) return print(io, renderToolHelp(tool, io.bin, app.definition.flagAliases));
    return await runTool(app, io, tool, rest, globals);
  } catch (error) {
    const failure = toSlipwayError(error);
    emitError(io, app, failure, agent);
    if (failure.code === "usage" && tool && !agent && io.isTTY) io.stderr(renderToolHelp(tool, io.bin, app.definition.flagAliases));
    return failure.exitCode;
  }
}

function print(io: CliIO, text: string): number {
  io.stdout(text.endsWith("\n") ? text : `${text}\n`);
  return EXIT.ok;
}

/** The bare version, which scripts compare. `agent-context` names the framework and its version. */
function printVersion(app: App, io: CliIO): number {
  return print(io, app.version);
}

function json(globals: Globals, value: unknown): string {
  return globals.format === "compact" ? JSON.stringify(value) : JSON.stringify(value, null, 2);
}

async function runBuiltin(app: App, io: CliIO, command: string, rest: string[], globals: Globals): Promise<number> {
  // `<built-in> --help` explains the command instead of running it.
  if (globals.help && command === "install") return print(io, (await import("./install.js")).installHelp(app, io.bin));
  const login = app.definition.login;
  if (globals.help && command === "login" && typeof login === "object") return print(io, `\nUsage: ${io.bin} ${login.usage ?? "login"}\n\n${sentence(login.help)}\n`);
  // Printed steps are their own help.
  if (globals.help && command === "login" && typeof login === "string") return print(io, login);
  if (globals.help && command !== "help") return print(io, renderGeneralHelp(app, io.bin));
  const target = rest.find((token) => !token.startsWith("-"));
  switch (command) {
    case "tools":
      return print(io, renderList(app, app.tools(io.env), io.bin, io.env));
    case "version":
      return printVersion(app, io);
    case "help": {
      if (!target) return print(io, renderGeneralHelp(app, io.bin));
      const tool = app.find(target);
      if (!tool) throw new UsageError(`Unknown command '${target}'.`, { hint: `Run \`${app.bins.cli}\` to list commands.` });
      return print(io, renderToolHelp(tool, io.bin, app.definition.flagAliases));
    }
    case "schema": {
      const tool = target ? app.find(target) : undefined;
      if (!tool) throw new UsageError(`schema expects a command${target ? `; '${target}' is not one` : ""}.`, { hint: `Run \`${app.bins.cli}\` to list commands.` });
      if (rest.includes("--output")) {
        if (!tool.output) throw new UsageError(`${tool.command} declares no output schema.`);
        return print(io, json(globals, outputJsonSchema(tool.output)));
      }
      return print(io, json(globals, tool.jsonSchema));
    }
    case "agent-context":
      return print(io, json(globals, agentContext(app, io.env, io.bin, { brief: rest.includes("--brief") })));
    case "which": {
      const query = rest.filter((token) => !token.startsWith("-")).join(" ");
      if (!query) throw new UsageError("which expects the words for what you want to do: which schedule a post");
      // Only the close matches: on Threads the right command scored 20 and the eighth 9, and the
      // ten-line list cost an agent more to read than the answer was worth.
      const found = searchTools(app.tools(io.env), query, 10, app.definition.synonyms);
      const best = found[0]?.score ?? 0;
      const matches = found.filter(({ score }, index) => index < 3 || score >= best / 2);
      if (globals.format !== "auto") {
        return print(io, json(globals, matches.map(({ tool, score }) => ({ command: tool.command, title: tool.title, risk: tool.risk, score: Number(score.toFixed(2)) }))));
      }
      if (!matches.length) return print(io, `No command matches '${query}'. Run \`${app.bins.cli}\` to see them all.`);
      return print(io, matches.map(({ tool }) => toolLine(tool)).join("\n"));
    }
    case "doctor":
      return runDoctor(app, io, { network: rest.includes("--network"), json: globals.format !== "auto" });
    case "login": {
      if (typeof login === "function") return await login(io, rest);
      if (typeof login === "object") return await login.run(io, rest);
      if (typeof login === "string") return print(io, login);
      return print(io, `${app.title} reads its credentials from the environment. Run \`${io.bin} doctor\` to see what is missing.`);
    }
    case "completion":
      return print(io, completionScript(app, target, io.bin, io.env));
    case "install": {
      const { runInstall } = await import("./install.js");
      return runInstall(app, io, rest, { agent: globals.agent, dryRun: globals.dryRun, format: globals.format });
    }
    case "data": {
      const { runData } = await import("./data.js");
      return runData(app, io, rest, { format: globals.format, ...(globals.select ? { select: globals.select } : {}), agent: globals.agent });
    }
    default:
      throw new UsageError(`Unknown command '${command}'.`);
  }
}

async function readInput(io: CliIO, raw: string): Promise<Record<string, unknown>> {
  const value = raw === "-" ? parseJsonValue(await io.stdin(), "--input") : parseJsonValue(raw, "--input");
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError("--input expects a JSON object of arguments.");
  }
  return value as Record<string, unknown>;
}

async function runTool(app: App, io: CliIO, tool: Tool, rest: string[], globals: Globals): Promise<number> {
  const flags = flagsFor(tool.jsonSchema);
  const base = globals.input ? await readInput(io, globals.input) : {};
  const args = { ...base, ...parseToolArgs(rest, flags, tool.positional, app.definition.flagAliases) };
  if (globals.confirm && tool.requireConfirm) args.confirm = true;

  const missing = missingRequired(flags, args).filter((flag) => !(globals.all && tool.paginate && flag.key === tool.paginate.cursorArg));
  if (missing.length && !globals.dryRun) {
    throw new UsageError(`Missing ${missing.map((flag) => flag.flag).join(", ")}.`, { hint: `Run \`${io.bin} ${tool.command} --help\`.` });
  }
  if ((globals.all || globals.maxItems) && !tool.paginate) {
    throw new UsageError(`${tool.command} does not page, so --all and --max-items do not apply.`);
  }
  if (globals.wait && !tool.job) {
    throw new UsageError(`${tool.command} does not start a job, so --wait does not apply.`);
  }

  const controller = new AbortController();
  const onInterrupt = () => controller.abort(new DOMException("Interrupted", "AbortError"));
  const listens = partialIsProcess(io);
  if (listens) process.once("SIGINT", onInterrupt);
  const signal = globals.timeoutMs ? AbortSignal.any([controller.signal, AbortSignal.timeout(globals.timeoutMs)]) : controller.signal;

  const options = {
    surface: "cli" as const,
    confirmed: globals.confirm,
    dryRun: globals.dryRun,
    ...(globals.wait ? { waitMs: Number.POSITIVE_INFINITY } : {}),
    ...(globals.refresh ? { refresh: true } : {}),
    ...(io.isTTY && !globals.agent && tool.cache
      ? { onCache: ({ ageSeconds }: { ageSeconds: number }) => io.stderr(`(from the local cache, ${ageSeconds} s old; --refresh fetches it again)\n`) }
      : {}),
    signal,
    env: io.env,
    onProgress:
      io.isTTY && !globals.agent
        ? ({ progress, total, message }: { progress: number; total?: number; message?: string }) =>
            io.stderr(`… ${total ? `${progress}/${total}` : progress}${message ? ` ${message}` : ""}\n`)
        : undefined,
  };

  try {
    let result: unknown;
    if (tool.paginate && (globals.all || globals.maxItems) && !globals.dryRun) {
      result = await allPages(app, tool, args, options, globals.maxItems ?? Number.POSITIVE_INFINITY);
    } else {
      result = await app.invoke(tool.name, args, options);
    }

    if (globals.out) return writeOut(io, globals, tool, result);
    io.stdout(formatOutput(result, tool, { format: globals.format, select: globals.select }));
    return EXIT.ok;
  } finally {
    if (listens) process.removeListener("SIGINT", onInterrupt);
  }
}

/** Only the real process gets a Ctrl-C handler; a test harness passing its own stdout does not. */
function partialIsProcess(io: CliIO): boolean {
  return io.env === process.env;
}

/** Follow a cursor until the pages run out or enough items arrived, and return them as one list. */
async function allPages(
  app: App,
  tool: Tool,
  args: Record<string, unknown>,
  options: Parameters<App["invoke"]>[2],
  max: number,
): Promise<{ items: unknown[]; count: number; pages: number; next_cursor: unknown }> {
  const items: unknown[] = [];
  const run = await eachPage(app, tool, args, options, tool.paginate!.items, max, (page) => void items.push(...page));
  return { items, count: run.count, pages: run.pages, next_cursor: run.next_cursor };
}

/** Write to a new file only, readable by its owner, so an export never replaces something or leaks to other users. */
function writeOut(io: CliIO, globals: Globals, tool: Tool, result: unknown): number {
  const format: Format = globals.format === "auto" ? "json" : globals.format;
  const text = formatOutput(result, tool, { format, select: globals.select });
  try {
    writeFileSync(globals.out!, text, { flag: "wx", mode: 0o600 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new UsageError(
      code === "EEXIST" ? `${globals.out} already exists. Choose a new file name.` : `Could not write ${globals.out}: ${(error as Error).message}`,
    );
  }
  io.stdout(`${JSON.stringify({ saved: globals.out, bytes: Buffer.byteLength(text) })}\n`);
  return EXIT.ok;
}

/** A help line written for the command table reads as a sentence on its own `--help` page. */
function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  return `${trimmed[0]!.toUpperCase()}${trimmed.slice(1)}${/[.!?:]$/.test(trimmed) ? "" : "."}`;
}
