/**
 * `install <client>`: add this server to an MCP client's own configuration.
 *
 * Every client keeps its servers in a different file, in a different shape,
 * and passes the environment on differently. Codex forwards only variables it
 * is told to, Gemini CLI hides anything named like a key unless it is listed,
 * and Claude Desktop sees nothing from a shell at all. Getting one of those
 * wrong is a server that starts and then fails on its first call, so each
 * client's shape lives here once, checked against that client's own docs.
 *
 * A credential is never written into a client's file unless `--copy-env`
 * asks for it. Where a client can read a variable from its own environment,
 * the entry names the variable instead of holding its value.
 */

import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { App, CliIO } from "./app.js";
import { UsageError } from "./errors.js";

export type ClientId = "claude-code" | "codex" | "claude-desktop" | "cursor" | "vscode" | "gemini";
export type Scope = "user" | "project";

export const CLIENTS: Record<ClientId, { title: string; scopes: readonly Scope[] }> = {
  "claude-code": { title: "Claude Code", scopes: ["user", "project"] },
  codex: { title: "Codex", scopes: ["user", "project"] },
  "claude-desktop": { title: "Claude Desktop", scopes: ["user"] },
  cursor: { title: "Cursor", scopes: ["user", "project"] },
  vscode: { title: "VS Code", scopes: ["project"] },
  gemini: { title: "Gemini CLI", scopes: ["user", "project"] },
};

/** How a client starts the server. */
export type Launch = { command: string; args: string[] };

export type InstallOptions = {
  client: ClientId;
  scope: Scope;
  /** The key the server is listed under. Defaults to the app's name. */
  name: string;
  /** Copy the current values of the app's settings into the client's file. Only where a client cannot read them itself. */
  copyEnv: boolean;
  /** Start the server from this copy on disk rather than from npm. */
  local: boolean;
};

export type InstallPlan = {
  client: ClientId;
  scope: Scope;
  name: string;
  /** The file this changes, for clients configured by file. */
  file?: string;
  /** The command this runs, for a client with its own command for adding servers. */
  run?: { command: string; args: string[] };
  /** The entry as written. */
  entry: unknown;
  /** The file's full text after the change. */
  text?: string;
  /** Settings the client passes on from its own environment, settings copied in, and settings left for the person to add. */
  env: { forwarded: string[]; copied: string[]; toAdd: string[] };
  notes: string[];
};

/**
 * How a client should start this server: the published package through npx,
 * at `@latest` so a client picks up every release on its next start, or this
 * copy on disk.
 *
 * npx needs the binary named: a package with an MCP and a CLI binary leaves
 * npx to pick one otherwise, and the CLI started with no arguments prints its
 * command list instead of serving.
 */
export function launchFor(app: App, options: { local: boolean; entry?: string; platform?: NodeJS.Platform }): Launch {
  const platform = options.platform ?? process.platform;
  let launch: Launch;
  if (app.definition.package && !options.local) {
    launch = { command: "npx", args: ["--yes", `--package=${app.definition.package}@latest`, app.bins.mcp] };
  } else {
    const entry = options.entry ?? (process.argv[1] ? realpathSync(process.argv[1]) : undefined);
    if (!entry) throw new UsageError("Could not tell where this server is installed.", { hint: "Run install from the installed binary." });
    launch = { command: process.execPath, args: [entry] };
  }
  // Windows runs npx as a batch file, which a client that starts processes without a shell cannot launch directly.
  if (platform === "win32" && launch.command === "npx") return { command: "cmd", args: ["/c", "npx", ...launch.args] };
  return launch;
}

/** "A", "A and B", "A, B and C". */
function list(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** "it" or "them", for a list of settings. */
function them(names: readonly string[]): string {
  return names.length === 1 ? "it" : "them";
}

function home(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || homedir();
}

/** Where each client keeps its servers, from its own documentation. */
export function configFile(client: ClientId, scope: Scope, env: NodeJS.ProcessEnv, cwd: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const h = home(env);
  switch (client) {
    case "codex":
      return scope === "project" ? join(cwd, ".codex", "config.toml") : join(env.CODEX_HOME || join(h, ".codex"), "config.toml");
    case "claude-desktop":
      if (platform === "darwin") return join(h, "Library", "Application Support", "Claude", "claude_desktop_config.json");
      if (platform === "win32") return join(env.APPDATA || join(h, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
      throw new UsageError("Claude Desktop runs on macOS and Windows only.");
    case "cursor":
      return scope === "project" ? join(cwd, ".cursor", "mcp.json") : join(h, ".cursor", "mcp.json");
    case "vscode":
      return join(cwd, ".vscode", "mcp.json");
    case "gemini":
      return scope === "project" ? join(cwd, ".gemini", "settings.json") : join(h, ".gemini", "settings.json");
    case "claude-code":
      return undefined;
  }
}

/** A TOML basic string. JSON's escapes are TOML's escapes for every character a command or path holds. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** The keys install writes in a Codex table. Every other key, and every subtable, is the person's and stays. */
const CODEX_KEYS = new Set(["command", "args", "env_vars", "startup_timeout_sec"]);

function bracketDepth(text: string): number {
  // Brackets inside quoted strings do not count.
  const bare = text.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "");
  return (bare.match(/\[/g)?.length ?? 0) - (bare.match(/\]/g)?.length ?? 0);
}

function quotedStrings(text: string): string[] {
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => JSON.parse(`"${match[1]}"`) as string);
}

/**
 * Put `[mcp_servers.<name>]` into a TOML file. An existing table of that name
 * is updated in place: install's own keys are rewritten, `env_vars` keeps the
 * names it already had, and every other key and subtable stays as written. A
 * file that defines the server some other way is left alone, because
 * rewriting it would mean parsing all of TOML.
 */
export function upsertCodexServer(text: string, name: string, launch: Launch, forwarded: string[], usesNpx: boolean): string {
  const key = `(?:${escape(name)}|"${escape(name)}")`;
  const own = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*${key}\\s*(?:\\]|\\.)`);
  const header = /^\s*\[/;
  const lines = text.split("\n");

  let current = "";
  for (const line of lines) {
    if (header.test(line)) {
      current = line.trim().replace(/\s+/g, "");
      continue;
    }
    const inline = current === "[mcp_servers]" && new RegExp(`^\\s*${key}\\s*=`).test(line);
    const dotted = current === "" && new RegExp(`^\\s*mcp_servers\\s*\\.\\s*${key}\\s*[.=]`).test(line);
    if (inline || dotted) {
      throw new UsageError(`This file already defines ${name} in a form install does not rewrite.`, { hint: "Edit that entry by hand, or remove it and run install again." });
    }
  }

  const start = lines.findIndex((line) => own.test(line));
  let end = start + 1;
  if (start !== -1) while (end < lines.length && !(header.test(lines[end]!) && !own.test(lines[end]!))) end++;
  const block = start === -1 ? [] : lines.slice(start + 1, end);

  // Split the old table into install's keys, which are replaced, and the rest, which stays.
  const kept: string[] = [];
  const names = new Set(forwarded);
  let depth = 0;
  let skippedKey = "";
  let rest = block.length;
  for (let i = 0; i < block.length; i++) {
    const line = block[i]!;
    if (depth > 0) {
      if (skippedKey === "env_vars") for (const value of quotedStrings(line)) names.add(value);
      depth += bracketDepth(line);
      continue;
    }
    if (header.test(line)) {
      rest = i;
      break;
    }
    const match = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (match && CODEX_KEYS.has(match[1]!)) {
      skippedKey = match[1]!;
      if (skippedKey === "env_vars") for (const value of quotedStrings(match[2]!)) names.add(value);
      depth = Math.max(0, bracketDepth(match[2]!));
      continue;
    }
    kept.push(line);
  }
  const subtables = block.slice(rest);

  const tableKey = /^[A-Za-z0-9_-]+$/.test(name) ? name : tomlString(name);
  const table = [`[mcp_servers.${tableKey}]`, `command = ${tomlString(launch.command)}`, `args = [${launch.args.map(tomlString).join(", ")}]`];
  if (names.size) table.push(`env_vars = [${[...names].map(tomlString).join(", ")}]`);
  // npx downloads the package the first time, which can outlast Codex's ten-second default.
  if (usesNpx) table.push(`startup_timeout_sec = 60`);
  while (kept.length && kept[kept.length - 1]!.trim() === "") kept.pop();
  const ownLines = [...table, ...kept, ...(subtables.length ? ["", ...subtables] : [])];
  while (ownLines.length && ownLines[ownLines.length - 1]!.trim() === "") ownLines.pop();

  if (start === -1) {
    const body = text.replace(/\s*$/, "");
    return `${body}${body ? "\n\n" : ""}${ownLines.join("\n")}\n`;
  }
  const after = lines.slice(end);
  while (after.length && after[0]!.trim() === "") after.shift();
  return [...lines.slice(0, start), ...ownLines, ...(after.length ? ["", ...after] : [""])].join("\n");
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Falls through to the refusal below.
  }
  throw new UsageError(`${file} is not plain JSON, so install will not rewrite it. It may hold comments.`, { hint: "Add the entry by hand: run install again with --dry-run to see it." });
}

export function planInstall(app: App, options: InstallOptions, context: { env: NodeJS.ProcessEnv; cwd: string; entry?: string; platform?: NodeJS.Platform }): InstallPlan {
  const { client, scope, name } = options;
  const info = CLIENTS[client];
  if (!info.scopes.includes(scope)) {
    throw new UsageError(`${info.title} has no ${scope} scope here. It takes: ${info.scopes.join(", ")}.`);
  }
  const launch = launchFor(app, { local: options.local, ...(context.entry ? { entry: context.entry } : {}), ...(context.platform ? { platform: context.platform } : {}) });
  const usesNpx = launch.command === "npx" || launch.args.includes("npx");
  const settings = (app.definition.settings ?? []).filter((setting) => !setting.tuning);
  const variables = settings.map((setting) => setting.env);
  const env = { forwarded: [] as string[], copied: [] as string[], toAdd: [] as string[] };
  const notes: string[] = [];
  const file = configFile(client, scope, context.env, context.cwd, context.platform);

  if (client === "claude-code") {
    const entry = { type: "stdio", command: launch.command, args: launch.args };
    if (variables.length) notes.push(`Claude Code passes its own environment to the server, so whichever of ${list(variables)} you use go in the shell you start Claude Code from.`);
    return { client, scope, name, entry, env, notes, run: { command: "claude", args: ["mcp", "add-json", name, JSON.stringify(entry), "--scope", scope] } };
  }

  if (client === "codex") {
    env.forwarded = variables;
    const before = existsSync(file!) ? readFileSync(file!, "utf8") : "";
    const text = upsertCodexServer(before, name, launch, variables, usesNpx);
    if (variables.length) notes.push(`Codex passes ${list(variables)} on from its own environment, so whichever you use go where you start Codex.`);
    if (scope === "project") notes.push("Codex reads a project's .codex/config.toml only once the project is trusted.");
    const entry = upsertCodexServer("", name, launch, variables, usesNpx).trim();
    return { client, scope, name, file, entry, text, env, notes };
  }

  // The JSON clients. An existing entry keeps everything install does not manage: its own env values above all.
  const config = readJson(file!);
  const key = client === "vscode" ? "servers" : "mcpServers";
  const servers = (config[key] && typeof config[key] === "object" && !Array.isArray(config[key]) ? config[key] : {}) as Record<string, unknown>;
  const previous = (servers[name] && typeof servers[name] === "object" ? servers[name] : {}) as Record<string, unknown>;
  const previousEnv = (previous.env && typeof previous.env === "object" ? previous.env : {}) as Record<string, unknown>;
  const values: Record<string, unknown> = { ...previousEnv };
  const inputs: Array<Record<string, unknown>> = [];

  for (const setting of settings) {
    const variable = setting.env;
    if (variable in previousEnv) continue;
    if (client === "cursor") values[variable] = `\${env:${variable}}`;
    else if (client === "gemini") values[variable] = `\${${variable}}`;
    else if (client === "vscode" && setting.secret) {
      const id = variable.toLowerCase().replace(/_/g, "-");
      inputs.push({ type: "promptString", id, description: setting.description, password: true });
      values[variable] = `\${input:${id}}`;
    } else if (options.copyEnv && context.env[variable]) {
      values[variable] = context.env[variable]!;
      env.copied.push(variable);
      continue;
    } else {
      env.toAdd.push(variable);
      continue;
    }
    env.forwarded.push(variable);
  }

  const server: Record<string, unknown> = {
    ...(client === "cursor" || client === "vscode" ? { type: "stdio" } : {}),
    ...previous,
    command: launch.command,
    args: launch.args,
    ...(Object.keys(values).length ? { env: values } : {}),
  };
  const next: Record<string, unknown> = { ...config, [key]: { ...servers, [name]: server } };
  if (client === "vscode" && inputs.length) {
    const existing = Array.isArray(config.inputs) ? (config.inputs as Array<Record<string, unknown>>) : [];
    next.inputs = [...existing, ...inputs.filter((input) => !existing.some((have) => have.id === input.id))];
  }

  if (client === "cursor" && env.forwarded.length) notes.push(`Cursor reads ${list(env.forwarded)} from its own environment.`);
  if (client === "gemini") {
    if (env.forwarded.length) notes.push(`Gemini CLI fills ${list(env.forwarded)} from its own environment. It hides variables named like keys from servers unless an entry lists them, as this one does.`);
    notes.push("Gemini CLI starts servers only in folders you trust.");
  }
  if (client === "vscode") {
    if (inputs.length) notes.push(`VS Code asks for ${list(inputs.map((input) => String(input.id)))} the first time the server starts, and stores the answer securely.`);
    if (env.toAdd.length) notes.push(`${list(env.toAdd)} ${env.toAdd.length === 1 ? "keeps its default" : "keep their defaults"}. Add ${them(env.toAdd)} to the server's env in ${file} to change ${them(env.toAdd)}.`);
  }
  if (client === "claude-desktop") {
    if (env.copied.length) notes.push(`Copied ${list(env.copied)} from this shell into ${file}, which is now readable by you only.`);
    if (env.toAdd.length) {
      notes.push(`Claude Desktop does not read a shell's environment, so whichever of ${list(env.toAdd)} you use go in the env of "${name}" in ${file}, or run install again with --copy-env to copy them from this shell.`);
    }
  }
  return { client, scope, name, file, entry: server, text: `${JSON.stringify(next, null, 2)}\n`, env, notes };
}

/** A timestamp for a backup file name: 20261004-183000. */
function stamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

export type InstallResult = { plan: InstallPlan; backup?: string; ran?: { code: number; output: string } };

/** Write the plan's file, keeping a copy of the old one, or run the client's own command. */
export async function applyInstall(plan: InstallPlan, io: Pick<CliIO, "env">): Promise<InstallResult> {
  if (plan.run) {
    const run = plan.run;
    const ran = await new Promise<{ code: number; output: string }>((resolve) => {
      execFile(run.command, run.args, { env: io.env, timeout: 60_000 }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as NodeJS.ErrnoException).code === "number" ? Number((error as NodeJS.ErrnoException).code) : 1) : 0;
        resolve({ code: (error as NodeJS.ErrnoException | null)?.code === "ENOENT" ? 127 : code, output: `${stdout}${stderr}`.trim() });
      });
    });
    return { plan, ran };
  }
  const file = plan.file!;
  mkdirSync(dirname(file), { recursive: true });
  let backup: string | undefined;
  if (existsSync(file)) {
    backup = `${file}.bak-${stamp()}`;
    copyFileSync(file, backup);
  }
  writeFileSync(file, plan.text!);
  // A file holding a copied credential is the owner's alone, whether or not install created it.
  if (plan.env.copied.length && process.platform !== "win32") chmodSync(file, 0o600);
  return { plan, ...(backup ? { backup } : {}) };
}
