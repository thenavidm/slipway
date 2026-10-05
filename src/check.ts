/**
 * `slipway check`: the release gate.
 *
 * Unit tests prove a handler works. They do not prove that what a client
 * receives matches what the CLI offers, that a schema will be accepted, that an
 * example in the README still runs, or that the server answers when nothing is
 * configured. Those are the failures that reach users, so they are checked here,
 * against the real server, over the real protocol.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "./app.js";
import { agentContext } from "./cli/context.js";
import { flagsFor } from "./cli/flags.js";
import { BUILTINS, GLOBAL_FLAGS, renderToolHelp } from "./cli/help.js";
import { connectInMemory } from "./rpc.js";
import { repeatedDefinitions, schemaBytes, validate, formatIssues, type JsonSchema } from "./schema.js";
import { REQUIRES_USER_INTERACTION } from "./server.js";
import type { Tool } from "./tool.js";

export type Finding = { level: "error" | "warn"; check: string; tool?: string; message: string };

export type CheckOptions = {
  env?: NodeJS.ProcessEnv;
  /** Markdown files whose commands and flags must exist: README.md, SKILL.md. */
  docs?: string[];
  /** The built entry point, to check it starts and answers with nothing configured. */
  bin?: string;
  /** Advertised schema size per tool that earns a warning, and an error. */
  schemaBudget?: { warnBytes: number; errorBytes: number };
  /** The app's package.json, to check that `npx -y <package>` starts the MCP server. */
  packageJson?: string;
};

export type CheckReport = {
  ok: boolean;
  errors: number;
  warnings: number;
  findings: Finding[];
  stats: {
    /** Tools on under this environment. */
    tools: number;
    /** Every tool the app defines, whatever the environment turns on. Schema sizes cover all of them. */
    allTools: number;
    reads: number;
    writes: number;
    irreversible: number;
    confirmed: number;
    typedOutput: number;
    schemaBytes: number;
    largestTool?: { name: string; bytes: number };
    startupMs?: number;
  };
};

const PROPERTY = /^[A-Za-z0-9_.-]{1,64}$/;
const DEFAULT_BUDGET = { warnBytes: 16 * 1024, errorBytes: 128 * 1024 };

function strip(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = schema;
  return rest;
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  );
}

type MetaValidator = (schema: JsonSchema) => string | undefined;

/** Draft 2020-12 meta-schema validation, the check Claude Code runs before accepting a tool. Needs ajv. */
async function metaValidator(): Promise<MetaValidator | undefined> {
  try {
    const module = (await import("ajv/dist/2020.js" as string)) as { default: new (options: object) => { validateSchema(s: object): boolean; errorsText(e?: unknown): string; errors?: unknown } };
    const ajv = new module.default({ strict: false, validateFormats: false });
    return (schema) => (ajv.validateSchema(schema) ? undefined : ajv.errorsText(ajv.errors));
  } catch {
    return undefined;
  }
}

export async function checkApp(app: App, options: CheckOptions = {}): Promise<CheckReport> {
  const env = options.env ?? process.env;
  const budget = options.schemaBudget ?? DEFAULT_BUDGET;
  const findings: Finding[] = [];
  const add = (level: Finding["level"], check: string, message: string, tool?: string) => findings.push({ level, check, message, ...(tool ? { tool } : {}) });
  const tools = app.tools(env);

  const meta = await metaValidator();
  if (!meta) add("warn", "schema", "ajv is not installed, so schemas were not checked against JSON Schema 2020-12. Add ajv as a dev dependency.");

  let totalBytes = 0;
  let largest: { name: string; bytes: number } | undefined;

  for (const command of app.definition.commands ?? []) {
    if ((BUILTINS as readonly string[]).includes(command.name) || app.find(command.name)) {
      add("error", "names", `The terminal command '${command.name}' has the name of a built-in or a tool. Rename it.`);
    }
  }
  for (const [alias, key] of Object.entries(app.definition.flagAliases ?? {})) {
    const takes = app.allTools.some((tool) => Object.keys((tool.jsonSchema.properties as Record<string, unknown> | undefined) ?? {}).includes(key));
    if (!takes) add("error", "names", `--${alias} points at '${key}', which no tool's input has.`);
  }
  // A synonym pointing at a word no tool uses is a redirect to nowhere that quietly stops matching.
  const vocabulary = new Set(app.allTools.flatMap((tool) => `${tool.name} ${tool.title} ${tool.description}`.toLowerCase().split(/[^a-z0-9]+/)));
  for (const [word, targets] of Object.entries(app.definition.synonyms ?? {})) {
    for (const target of targets) {
      if (!vocabulary.has(target.toLowerCase()) && !app.allTools.some((tool) => tool.name === target)) {
        add("warn", "synonyms", `'${word}' points at '${target}', which no tool's name, title or description uses.`);
      }
    }
  }
  const httpPort = app.definition.httpPort;
  if (httpPort !== undefined && (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535)) {
    add("error", "http", `httpPort is ${httpPort}, which is not a port number from 1 to 65535.`);
  }

  for (const tool of app.allTools) {
    if ((BUILTINS as readonly string[]).includes(tool.command)) {
      add("error", "names", `'${tool.command}' is a built-in CLI command. Rename the tool.`, tool.name);
    }
    const words = tool.description.split(/\s+/).filter(Boolean).length;
    if (tool.description.length < 30 || words < 5) {
      add("warn", "descriptions", "The description is too thin to choose this tool by. Say what it does and when to use it.", tool.name);
    }
    if (tool.title.length > 60) add("warn", "descriptions", "The title is long for a picker; keep it under 60 characters.", tool.name);
    if (tool.requireConfirm && !tool.summary) {
      add("warn", "safety", "A confirmed tool with no summary shows only its name in the refusal and the audit log.", tool.name);
    }

    const schema = tool.jsonSchema;
    if (schema.type !== "object") add("error", "schema", "The input schema's root must be an object.", tool.name);
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      if (key in schema) add("warn", "schema", `A root-level ${key} is flattened by some clients; nest it inside a property.`, tool.name);
    }
    const properties = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const name of Object.keys(properties)) {
      if (!PROPERTY.test(name)) add("error", "schema", `Property '${name}' must be 1-64 letters, digits, '_', '.' or '-'.`, tool.name);
    }
    const undocumented = Object.entries(properties).filter(([name, prop]) => name !== "confirm" && !prop.description).map(([name]) => name);
    if (undocumented.length) add("warn", "descriptions", `No description for: ${undocumented.join(", ")}.`, tool.name);
    const problem = meta?.(schema);
    if (problem) add("error", "schema", `Not valid JSON Schema 2020-12: ${problem}`, tool.name);
    // A JSON Schema validator compiles on the tool's first call, so compile each one here instead.
    for (const [which, candidate] of [["input", tool.schema], ["output", tool.output]] as const) {
      try {
        await candidate?.["~standard"].validate({});
      } catch (error) {
        add("error", "schema", `The ${which} schema does not compile: ${(error as Error).message}`, tool.name);
      }
    }

    const bytes = schemaBytes(schema);
    totalBytes += bytes;
    if (!largest || bytes > largest.bytes) largest = { name: tool.name, bytes };
    if (bytes > budget.errorBytes) add("error", "size", `The schema is ${Math.round(bytes / 1024)} KB. Advertise a short schema and validate the full one in the handler.`, tool.name);
    else if (bytes > budget.warnBytes) add("warn", "size", `The schema is ${Math.round(bytes / 1024)} KB, which a model pays for every time it loads this tool.`, tool.name);
    const repeated = repeatedDefinitions(schema);
    if (repeated.length) add("warn", "size", `Definitions appear more than once: ${repeated.slice(0, 5).join(", ")}${repeated.length > 5 ? "…" : ""}.`, tool.name);

    for (const example of tool.examples) {
      const result = await validate(tool.schema, example.args);
      if (!result.ok) add("error", "examples", `Example "${example.description}" does not match the schema: ${formatIssues(result.issues)}`, tool.name);
    }

    try {
      renderToolHelp(tool, app.bins.cli);
      flagsFor(schema);
    } catch (error) {
      add("error", "cli", `The CLI cannot describe this tool: ${(error as Error).message}`, tool.name);
    }
  }

  if (!app.definition.package) {
    add("warn", "install", "No package is set, so `install` points clients at this copy on disk instead of the published one. Set package to the npm name.");
  }
  if (options.packageJson) checkBins(app, options.packageJson, add);

  const instructions = app.instructions ?? "";
  if (!instructions) add("warn", "instructions", "No server instructions. Clients use them to decide when to reach for these tools.");
  else if (instructions.length > 512) {
    const opening = instructions.slice(0, 512).toLowerCase();
    if (!opening.includes(app.name.toLowerCase()) && !opening.includes(app.title.toLowerCase())) {
      add("warn", "instructions", `Some clients read only the first 512 characters, and those never say what ${app.title} is.`);
    }
  }

  try {
    agentContext(app, env, app.bins.cli);
  } catch (error) {
    add("error", "cli", `agent-context failed: ${(error as Error).message}`);
  }

  await checkParity(app, env, tools, add);
  for (const file of options.docs ?? []) checkDocs(app, file, add);

  let startupMs: number | undefined;
  if (options.bin) startupMs = await checkStartup(options.bin, add);

  const errors = findings.filter((finding) => finding.level === "error").length;
  return {
    ok: errors === 0,
    errors,
    warnings: findings.length - errors,
    findings,
    stats: {
      tools: tools.length,
      allTools: app.allTools.length,
      reads: tools.filter((tool) => tool.risk === "read").length,
      writes: tools.filter((tool) => tool.risk === "write").length,
      irreversible: tools.filter((tool) => tool.risk === "destructive").length,
      confirmed: tools.filter((tool) => tool.requireConfirm).length,
      typedOutput: tools.filter((tool) => tool.output).length,
      schemaBytes: totalBytes,
      ...(largest ? { largestTool: largest } : {}),
      ...(startupMs !== undefined ? { startupMs } : {}),
    },
  };
}

/**
 * What an MCP client receives must be exactly what the CLI offers, on both
 * protocol revisions a client may open with.
 */
async function checkParity(app: App, env: NodeJS.ProcessEnv, tools: Tool[], add: (level: Finding["level"], check: string, message: string, tool?: string) => void) {
  const policy = app.policy(env);
  if (policy.surface === "search") return;
  const seen = new Set<string>();
  // The same problem on both revisions is reported once.
  const once = (level: Finding["level"], check: string, message: string, tool?: string) => {
    const key = `${check}\0${message}\0${tool ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    add(level, check, message, tool);
  };
  for (const era of ["legacy", "modern"] as const) await checkParityIn(era, app, env, tools, once);
}

async function checkParityIn(
  era: "legacy" | "modern",
  app: App,
  env: NodeJS.ProcessEnv,
  tools: Tool[],
  add: (level: Finding["level"], check: string, message: string, tool?: string) => void,
) {
  const policy = app.policy(env);
  let client;
  try {
    client = await connectInMemory(app, env, { era });
  } catch (error) {
    add("error", "mcp", `The MCP server did not start (${era === "modern" ? "2026-07-28" : "2025"} protocol): ${(error as Error).message}`);
    return;
  }
  try {
    if ((client.initialize.instructions ?? "") !== (app.instructions ?? "")) add("error", "mcp", "The instructions a client receives differ from the app's.");
    const listed = await client.listTools();
    const byName = new Map(listed.map((tool) => [tool.name, tool]));
    for (const tool of tools) {
      const wire = byName.get(tool.name);
      if (!wire) {
        add("error", "mcp", "The CLI offers this tool but the MCP server does not list it.", tool.name);
        continue;
      }
      if (stable(strip(wire.inputSchema)) !== stable(strip(tool.jsonSchema))) {
        add("error", "mcp", "The schema a client receives differs from the one the CLI derives its flags from.", tool.name);
      }
      const annotations = wire.annotations ?? {};
      if (annotations.readOnlyHint !== (tool.risk === "read") || annotations.destructiveHint !== (tool.risk === "destructive")) {
        add("error", "mcp", "The annotations a client receives do not match the tool's risk.", tool.name);
      }
      if (tool.requireConfirm && policy.confirm === "human" && wire._meta?.[REQUIRES_USER_INTERACTION] !== true) {
        add("error", "mcp", "A confirmed tool is missing its request for a person's approval.", tool.name);
      }
      if (tool.output && !wire.outputSchema) add("error", "mcp", "The tool declares an output schema that clients never receive.", tool.name);
    }
    for (const wire of listed) {
      if (!tools.some((tool) => tool.name === wire.name)) add("error", "mcp", "The MCP server lists a tool the CLI does not offer.", wire.name);
    }
  } catch (error) {
    add("error", "mcp", `Listing tools failed: ${(error as Error).message}`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * `npx -y <package>` is how most people install a server, and npx starts one
 * binary without being told which. npm's rule: when every binary points to
 * the same file, it starts whichever one the registry lists first, and the
 * registry does not keep the order they were published in. Only a binary
 * named after the package, on a file of its own, is picked every time.
 */
function checkBins(app: App, file: string, add: (level: Finding["level"], check: string, message: string, tool?: string) => void) {
  let pkg: { name?: string; bin?: string | Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(file, "utf8")) as typeof pkg;
  } catch (error) {
    add("error", "install", `Could not read ${file}: ${(error as Error).message}`);
    return;
  }
  if (app.definition.package && pkg.name && pkg.name !== app.definition.package) {
    add("warn", "install", `The app's package is ${app.definition.package} but package.json is ${pkg.name}.`);
  }
  if (!pkg.bin || typeof pkg.bin === "string") return;
  const bins = pkg.bin;
  if (!(app.bins.mcp in bins)) {
    add("error", "install", `package.json has no ${app.bins.mcp} binary, so clients cannot start the server by name.`);
    return;
  }
  const unscoped = (pkg.name ?? "").split("/").pop() ?? "";
  const fix = `Add "${unscoped}": "dist/npx.js" to bin, where src/npx.ts holds only: import "./index.js";`;
  if (new Set(Object.values(bins)).size === 1) {
    add("error", "install", `Every binary runs the same file, so npx -y ${pkg.name} starts whichever one the registry lists first, which may be ${app.bins.cli}. ${fix}`);
  } else if (!(unscoped in bins)) {
    add("error", "install", `npx -y ${pkg.name} cannot choose between ${Object.keys(bins).join(", ")}. ${fix}`);
  } else if (unscoped === app.bins.cli || unscoped.startsWith(app.bins.cli)) {
    add("error", "install", `npx -y ${pkg.name} starts ${unscoped}, which runs as the CLI. Name the package so it does not start with ${app.bins.cli}.`);
  }
}

/** Every command and flag a README or SKILL.md tells someone to type must exist. */
function checkDocs(app: App, file: string, add: (level: Finding["level"], check: string, message: string, tool?: string) => void) {
  if (!existsSync(file)) {
    add("error", "docs", `${file} does not exist.`);
    return;
  }
  const text = readFileSync(file, "utf8");
  const bins = [app.bins.cli, app.bins.mcp].map((bin) => bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`(?:^|[\\s\`'"(])(?:${bins})((?:[ \\t]+[^\\s\`'"|;&)]+)*)`, "gm");
  const globals = new Set(GLOBAL_FLAGS.flatMap(([flag]) => flag.split(" / ").map((part) => part.split(" ")[0]!)).concat("--help", "-h", "--version", "-v", "--plain", "--confirm", "--wait", "--refresh", "--in", "--limit", "--cache", "--scope", "--name", "--copy-env", "--local", "--all", "--max-items", "--network", "--output", "--brief", "--http", "--port", "--no-color", "--no-input", "--yes", "--agent"));
  // Only code is something a reader copies and runs. A sentence that mentions
  // the binary ("if it fails, STOP") is prose and is not checked.
  for (const segment of codeSegments(text)) for (const match of segment.code.matchAll(pattern)) {
    // Everything after a shell comment is prose, not arguments.
    const raw = (match[1] ?? "").trim().split(/\s+/).filter(Boolean).map((token) => token.replace(/[.,;:]+$/, ""));
    const comment = raw.findIndex((token) => token.startsWith("#"));
    const tokens = comment === -1 ? raw : raw.slice(0, comment);
    const command = tokens.find((token) => !token.startsWith("-"));
    if (!command || /^[<$[{…]/.test(command)) continue;
    // The match may begin on the character before the binary, a newline included.
    const at = segment.offset + (match.index ?? 0) + (match[0].length - match[0].trimStart().length);
    const line = text.slice(0, at).split("\n").length;
    if ((BUILTINS as readonly string[]).includes(command) || app.definition.commands?.some((custom) => custom.name === command)) continue;
    const tool = app.find(command);
    if (!tool) {
      add("error", "docs", `${file}:${line} names '${command}', which is not a command.`);
      continue;
    }
    const known = new Set(flagsFor(tool.jsonSchema).flatMap((flag) => [flag.flag, `--${flag.key}`, ...(flag.kind === "boolean" ? [`--no-${flag.flag.slice(2)}`] : [])]));
    for (const token of tokens) {
      if (!token.startsWith("--")) continue;
      const flag = token.split("=")[0]!;
      if (!known.has(flag) && !globals.has(flag)) add("error", "docs", `${file}:${line} passes ${flag} to '${command}', which does not take it.`, tool.name);
    }
  }
}

/** Fenced code blocks and inline code spans, with where each starts in the file. */
function codeSegments(text: string): Array<{ code: string; offset: number }> {
  const segments: Array<{ code: string; offset: number }> = [];
  const fenced: Array<[number, number]> = [];
  for (const match of text.matchAll(/^(```|~~~)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm)) {
    const start = (match.index ?? 0) + match[0].indexOf("\n") + 1;
    segments.push({ code: match[2] ?? "", offset: start });
    fenced.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  }
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const at = match.index ?? 0;
    if (fenced.some(([start, end]) => at >= start && at < end)) continue;
    segments.push({ code: match[1] ?? "", offset: at + 1 });
  }
  return segments;
}

/**
 * Start the built server the way a client does, with nothing configured, and
 * expect an answer. A server that exits or hangs here is broken for every new
 * user, however good its tests are.
 */
function checkStartup(bin: string, add: (level: Finding["level"], check: string, message: string) => void): Promise<number | undefined> {
  return new Promise((resolve) => {
    const home = mkdtempSync(join(tmpdir(), "slipway-check-"));
    const started = performance.now();
    const child = spawn(process.execPath, [bin], { cwd: home, env: { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: home }, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let done = false;
    const finish = (ms?: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(ms);
    };
    const timer = setTimeout(() => {
      add("error", "startup", "The server did not answer initialize within 10 seconds with nothing configured.");
      finish();
    }, 10_000);
    child.on("exit", (code) => {
      if (!done) {
        add("error", "startup", `The server exited with code ${code} before answering. It must start and explain what is missing instead.`);
        finish();
      }
    });
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('"protocolVersion"')) finish(Math.round(performance.now() - started));
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "slipway-check", version: "0" } } })}\n`);
  });
}
