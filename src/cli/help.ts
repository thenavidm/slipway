/**
 * What a person sees before they know what to type.
 *
 * An agent reads this too, and pays for every token of it, so each screen
 * shows what applies and points to the rest instead of repeating it.
 */

import type { App } from "../app.js";
import { EXIT } from "../errors.js";
import { policyEnvNames, riskMark, visibility } from "../policy.js";
import { firstSentence } from "../search.js";
import type { Tool } from "../tool.js";
import { flagsFor, type Flag } from "./flags.js";

const COLUMN = 30;

/** The words the CLI owns, which no tool command may take. */
export const BUILTINS = ["help", "tools", "schema", "agent-context", "which", "doctor", "login", "completion", "version", "data", "install"] as const;

export const GLOBAL_FLAGS: Array<[string, string]> = [
  ["--json", "pretty JSON"],
  ["--compact", "one-line JSON"],
  ["--jsonl", "one JSON value per line, for lists"],
  ["--csv / --tsv", "a table, for lists of records"],
  ["--quiet", "one value per line: ids, or the one --select field"],
  ["--select <a,b.c>", "keep only these fields; dotted paths descend"],
  ["--agent", "JSON, compact, no prompts, no color. Never confirms anything"],
  ["--out <file>", "write the output to a new file instead of stdout"],
  ["--input <json|@file|->", "all arguments as one JSON object; flags override it"],
  ["--dry-run", "check everything and print what would run, without running it"],
  ["--wait", "for a job: wait until it finishes, however long that takes"],
  ["--refresh", "skip the local cache and fetch again"],
  ["--timeout <ms>", "give up after this long"],
];

function line(left: string, help: string): string[] {
  if (!help) return [left];
  return left.length < COLUMN ? [`${left.padEnd(COLUMN)}${help}`] : [left, `${" ".repeat(COLUMN)}${help}`];
}

function riskWords(tool: Tool): string {
  return tool.risk === "read" ? "read only" : tool.risk === "write" ? "writes, reversible" : "public or irreversible";
}

/** The output flags a command can use: the four every command takes, and those its kind adds. */
function outputFlagsFor(tool: Tool): Array<[string, string]> {
  const wanted = new Set(["--json", "--compact", "--select <a,b.c>", "--agent"]);
  if (tool.risk !== "read") wanted.add("--dry-run");
  if (tool.cache) wanted.add("--refresh");
  if (tool.paginate || tool.sync) for (const flag of ["--jsonl", "--csv / --tsv", "--quiet"]) wanted.add(flag);
  return GLOBAL_FLAGS.filter(([flag]) => wanted.has(flag));
}

/** Why some commands are not listed, and the setting that lists them. */
function hiddenNote(app: App, env: NodeJS.ProcessEnv): string[] {
  const policy = app.policy(env);
  const names = policyEnvNames(app.envPrefix);
  const off = new Set<string>();
  let byToolset = 0;
  let byReadOnly = 0;
  for (const tool of app.allTools) {
    const seen = visibility(tool, policy);
    if (seen.visible) continue;
    if (seen.reason === "read-only") byReadOnly += 1;
    else {
      byToolset += 1;
      for (const tag of tool.tags) if (policy.toolsets === "all" || !policy.toolsets.has(tag)) off.add(tag);
    }
  }
  const lines: string[] = [];
  if (byToolset) {
    const sets = [...off].sort();
    lines.push(`  ${byToolset} more ${byToolset === 1 ? "command is" : "commands are"} in ${sets.join(", ")}, off: ${names.toolsets}=${sets.join(",")} turns ${byToolset === 1 ? "it" : "them"} on.`);
  }
  if (byReadOnly) lines.push(`  ${byReadOnly} ${byReadOnly === 1 ? "write is" : "writes are"} hidden by ${names.readOnly}=1.`);
  return lines.length ? [...lines, ``] : [];
}

export function renderList(app: App, tools: readonly Tool[], bin: string, env: NodeJS.ProcessEnv = process.env): string {
  const width = Math.max(10, ...tools.map((tool) => tool.command.length)) + 2;
  const lines = [``, `${bin} ${app.version}: ${tools.length} ${tools.length === 1 ? "command" : "commands"}`];
  const toolsets = app.definition.toolsets ?? {};

  const groups = new Map<string, Tool[]>();
  for (const tool of tools) {
    const group = tool.tags[0] ?? "";
    groups.set(group, [...(groups.get(group) ?? []), tool]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
  const grouped = ordered.length > 1 || (ordered[0]?.[0] ?? "") !== "";

  if (!grouped) lines.push(``);
  for (const [group, members] of ordered) {
    if (grouped) lines.push(``, `  ${group || "general"}${group && toolsets[group] ? `: ${toolsets[group]}` : ""}`);
    for (const tool of members) lines.push(`  ${riskMark(tool.risk)} ${tool.command.padEnd(width)}${tool.title}`);
  }
  // The legend says `!` needs --confirm only when that holds for every listed command.
  const confirmByRisk = tools.every((tool) => tool.requireConfirm === (tool.risk === "destructive"));
  lines.push(
    ``,
    `  * writes    ! public or irreversible${confirmByRisk ? ", needs --confirm" : ""}`,
    ``,
    `  ${bin} <command> --help    what one takes, with examples`,
    `  ${bin} which <words>       find the command for a task`,
    `  ${bin} --help              flags, settings and setup`,
    ``,
    ...hiddenNote(app, env),
  );
  return lines.join("\n");
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** An example's arguments as the command someone would type. */
export function exampleCommand(bin: string, tool: Tool, args: Record<string, unknown>): string {
  const parts = [bin, tool.command];
  const rest = { ...args };
  for (const key of tool.positional) {
    const value = rest[key];
    if (value === undefined || typeof value === "object") break;
    parts.push(shellQuote(String(value)));
    delete rest[key];
  }
  for (const [key, value] of Object.entries(rest)) {
    const flag = `--${key.replace(/_/g, "-")}`;
    if (value === true) parts.push(flag);
    else if (value === false) parts.push(`${flag}=false`);
    else if (Array.isArray(value) && value.every((item) => typeof item !== "object")) for (const item of value) parts.push(flag, shellQuote(String(item)));
    else if (value !== null && typeof value === "object") parts.push(flag, shellQuote(JSON.stringify(value)));
    else if (value !== undefined) parts.push(flag, shellQuote(String(value)));
  }
  return parts.join(" ");
}

function placeholder(flag: Flag): string {
  if (flag.kind === "boolean") return "";
  if (flag.choices) return flag.choices.length <= 6 ? ` <${flag.choices.join("|")}>` : " <choice>";
  return ` <${flag.kind === "json" ? "json|@file" : flag.kind}>`;
}

export function renderToolHelp(tool: Tool, bin: string): string {
  const flags = flagsFor(tool.jsonSchema).filter((flag) => flag.key !== "confirm");
  const required = flags.filter((flag) => flag.required);
  const optional = flags.filter((flag) => !flag.required);
  const positional = tool.positional.length ? tool.positional : required[0] ? [required[0].key] : [];

  const usage = [
    `${bin} ${tool.command}`,
    ...required.map((flag) => (positional.includes(flag.key) ? `<${flag.key}>` : `${flag.flag}${placeholder(flag)}`)),
    optional.length ? "[options]" : "",
    tool.requireConfirm ? "--confirm" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // The title is already on the command list; the description says more.
  const lines = [``, tool.description, ``, `Usage:`, `  ${usage}`, ``];
  const describe = (list: Flag[], heading: string, after: string[] = []) => {
    if (!list.length && !after.length) return;
    lines.push(`${heading}:`);
    for (const flag of list) {
      const extra = [flag.repeatable ? "Repeatable." : "", flag.default !== undefined ? `Default ${JSON.stringify(flag.default)}.` : ""]
        .filter(Boolean)
        .join(" ");
      lines.push(...line(`  ${flag.flag}${placeholder(flag)}`, [flag.help, extra].filter(Boolean).join(" ")));
    }
    lines.push(...after, ``);
  };
  describe(required, "Required", tool.requireConfirm ? line("  --confirm", "it runs only with this; --agent never adds it") : []);
  describe(optional, "Options");

  if (tool.paginate) {
    lines.push(`Pages:`, ...line("  --all", "follow every page and print all items"), ...line("  --max-items <n>", "stop after this many items"), ``);
  }
  if (tool.job) {
    const check = tool.statusOf ? "" : `${tool.command}-status <job-id>`;
    lines.push(
      `Job:`,
      ...line("  --wait", "wait until the job finishes"),
      ...line("  --wait-seconds <n>", "wait this long, then print the job to check later"),
      ...(check ? line(`  ${check}`, "check on it later") : []),
      ``,
    );
  }
  if (tool.examples.length) {
    lines.push(`Examples:`);
    for (const example of tool.examples) lines.push(`  # ${example.description}`, `  ${exampleCommand(bin, tool, example.args)}`, ``);
  }
  lines.push(`Output:`);
  for (const [flag, help] of outputFlagsFor(tool)) lines.push(...line(`  ${flag}`, help));
  lines.push(``, `Risk: ${riskWords(tool)}`, ``);
  return lines.join("\n");
}

export function renderGeneralHelp(app: App, bin: string): string {
  const names = policyEnvNames(app.envPrefix);
  const cache = app.allTools.some((tool) => tool.cache);
  const sync = app.allTools.some((tool) => tool.sync);
  const jobs = app.allTools.some((tool) => tool.job);
  // An agent often reads this first and pays for it again on every later step, so the
  // rarely needed commands share one line and Slipway's own settings say only what they do.
  const commands: Array<[string, string]> = [
    [app.bins.cli, "list the commands"],
    [`${bin} <command> --help`, "what one takes, with examples"],
    [`${bin} which <words>`, "find the command for a task"],
    [`${bin} doctor${app.definition.doctorNetwork ? "" : " [--network]"}`, "check the setup and say what is wrong"],
    typeof app.definition.login === "object"
      ? [`${bin} ${app.definition.login.usage ?? "login"}`, app.definition.login.help]
      : [`${bin} login`, "how to connect an account"],
    ...(app.definition.commands ?? []).map((command): [string, string] => [`${bin} ${command.usage ?? command.name}`, command.help]),
    [`${bin} install <client>`, "add the server to an MCP client; install --help lists them"],
    ...(cache || sync ? ([[`${bin} data`, "what is kept on this machine; data clear [<command>] deletes it"]] as Array<[string, string]>) : []),
    ...(sync
      ? ([
          [`${bin} data sync <command>`, "copy every page of a list to this machine"],
          [`${bin} data search <words>`, "search synced records offline (--in <command>)"],
          [`${bin} data sql "<select>"`, "query local data with read-only SQL"],
        ] as Array<[string, string]>)
      : []),
    [app.bins.mcp, "the MCP server over stdio; --http [--port N] for HTTP"],
  ];
  // Tuning keeps a working default, so it is named on one line; agent-context says what each does.
  const tuning = (app.definition.settings ?? []).filter((setting) => setting.tuning).map((setting) => setting.env);
  const settings: Array<[string, string]> = [
    ...(app.definition.settings ?? []).filter((setting) => !setting.tuning).map((setting): [string, string] => [setting.env, setting.description]),
    [`${names.readOnly}=1`, "hide and refuse every write"],
    [`${names.allowDestructive}=0`, "refuse the irreversible writes"],
    [`${names.toolsets}=a,b`, "only these toolsets, or all"],
    [`${names.surface}=search`, "MCP lists three finder tools instead"],
    [`${names.auditLog}=<file>`, "log every attempted write"],
    [`${names.toolTimeoutMs}=<ms>`, "deadline for any tool"],
    [`${names.confirm}=model`, "confirm: true alone confirms over MCP"],
    ...(cache ? ([[`${names.cache}=0`, "never answer from the local cache"]] as Array<[string, string]>) : []),
    ...(cache || sync ? ([[`${names.dataDir}=<dir>`, "keep local data in this folder"]] as Array<[string, string]>) : []),
    [`${app.envPrefix}_HTTP_PORT / _HOST / _TOKEN`, "for --http"],
    [`${app.envPrefix}_DEBUG=1`, "debug lines on stderr"],
  ];
  // Flags that cannot apply here (jobs, the cache) are left out; agent-context lists every one.
  const flags = GLOBAL_FLAGS.map(([flag]) => flag).filter(
    (flag) => flag !== "--agent" && (flag !== "--wait" || jobs) && (flag !== "--refresh" || cache),
  );
  const width = Math.max(...[...commands, ...settings].map(([left]) => left.length)) + 3;
  const row = ([left, help]: [string, string]) => `  ${left.padEnd(width)}${help}`;
  const lines = [
    ``,
    `${app.title} ${app.version}`,
    ``,
    ...commands.map(row),
    `  Also: schema <command>, agent-context [--brief] (all of this as JSON), completion <shell>.`,
    ``,
    `Flags: ${flags.join(", ")}, and --agent: compact JSON, no prompts, never confirms a write.`,
    ``,
    `Settings:`,
    ...settings.map(row),
    ...(tuning.length ? [`  Also: ${tuning.join(", ")}, described in agent-context.`] : []),
    ``,
    `Exit codes: ${EXIT.ok} ok, ${EXIT.error} unexpected, ${EXIT.usage} usage or refused, ${EXIT.notFound} not found, ${EXIT.auth} auth, ${EXIT.api} API, ${EXIT.rateLimited} rate limited, ${EXIT.notConfigured} not configured`,
    ``,
  ];
  if (app.definition.links?.repository) lines.push(app.definition.links.repository, ``);
  return lines.join("\n");
}

/** One line per tool, for search results and listings. */
export function toolLine(tool: Tool): string {
  return `${riskMark(tool.risk)} ${tool.command}  ${tool.title}: ${firstSentence(tool.description, 80)}`;
}
