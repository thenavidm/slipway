/**
 * What a person sees before they know what to type.
 */

import type { App } from "../app.js";
import { EXIT } from "../errors.js";
import { policyEnvNames, riskMark } from "../policy.js";
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
  const base = tool.risk === "read" ? "read only" : tool.risk === "write" ? "writes, reversible" : "public or irreversible";
  return tool.requireConfirm ? `${base}, runs only with --confirm` : base;
}

export function renderList(app: App, tools: readonly Tool[], bin: string): string {
  const width = Math.max(10, ...tools.map((tool) => tool.command.length)) + 2;
  const lines = [``, `${app.title} ${app.version}${app.description ? `: ${app.description}` : ""}`, ``];
  const toolsets = app.definition.toolsets ?? {};

  const groups = new Map<string, Tool[]>();
  for (const tool of tools) {
    const group = tool.tags[0] ?? "";
    groups.set(group, [...(groups.get(group) ?? []), tool]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
  const grouped = ordered.length > 1 || (ordered[0]?.[0] ?? "") !== "";

  lines.push(`Commands (${tools.length})`);
  for (const [group, members] of ordered) {
    if (grouped) lines.push(``, `  ${group || "general"}${group && toolsets[group] ? `: ${toolsets[group]}` : ""}`);
    for (const tool of members) lines.push(`  ${riskMark(tool.risk)} ${tool.command.padEnd(width)}${tool.title}`);
  }
  lines.push(
    ``,
    `  * writes    ! public or irreversible`,
    ``,
    `  ${bin} <command> --help       what a command takes, with examples`,
    `  ${bin} which <words>          find the command for a task`,
    `  ${bin} schema <command>       the JSON Schema an MCP client sees`,
    `  ${bin} agent-context          everything above, as JSON for an agent`,
    `  ${bin} doctor                 check the setup`,
    `  ${bin} install <client>       add it to an MCP client: codex, claude-code, cursor…`,
    ``,
  );
  const hidden = app.allTools.length - tools.length;
  if (hidden > 0) {
    const names = policyEnvNames(app.envPrefix);
    lines.push(`  ${hidden} more ${hidden === 1 ? "command is" : "commands are"} off: see ${names.readOnly} and ${names.toolsets} in \`${bin} help\`.`, ``);
  }
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

  const lines = [``, `${tool.title}`, ``, tool.description, ``, `Usage:`, `  ${usage}`, ``];
  const describe = (list: Flag[], heading: string) => {
    if (!list.length) return;
    lines.push(`${heading}:`);
    for (const flag of list) {
      const extra = [flag.repeatable ? "Repeatable." : "", flag.default !== undefined ? `Default ${JSON.stringify(flag.default)}.` : ""]
        .filter(Boolean)
        .join(" ");
      lines.push(...line(`  ${flag.flag}${placeholder(flag)}`, [flag.help, extra].filter(Boolean).join(" ")));
    }
    lines.push(``);
  };
  describe(required, "Required");
  describe(optional, "Options");

  if (tool.requireConfirm) {
    lines.push(`Safety:`, ...line("  --confirm", "required: this runs only when you mean it"), ``);
  }
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
  for (const [flag, help] of GLOBAL_FLAGS) lines.push(...line(`  ${flag}`, help));
  lines.push(``, `Risk: ${riskWords(tool)}`, ``);
  return lines.join("\n");
}

export function renderGeneralHelp(app: App, bin: string): string {
  const names = policyEnvNames(app.envPrefix);
  const lines = [
    ``,
    `${app.title} ${app.version}${app.description ? `: ${app.description}` : ""}`,
    ``,
    `Usage:`,
    `  ${app.bins.mcp}                      run the MCP server over stdio (what an MCP client launches)`,
    `  ${app.bins.mcp} --http [--port N]    run it over HTTP`,
    `  ${bin}                      list every command`,
    `  ${bin} <command> [flags]    run one`,
    ``,
    `Commands:`,
    ...line("  <command> --help", "what a command takes, with examples"),
    ...line("  which <words>", "find the command for a task"),
    ...line("  schema <command>", "the JSON Schema an MCP client sees (--output for the result's)"),
    ...line("  agent-context", "commands, flags, risk, exit codes and settings as JSON"),
    ...line("  doctor [--network]", "check the setup and say what is wrong"),
    ...line("  login", "how to connect an account"),
    ...line("  install <client>", "add this server to claude-code, codex, claude-desktop, cursor, vscode or gemini"),
    ...line("  completion <shell>", "tab completion for bash, zsh or fish"),
    ...line("  version", "print the version"),
    ``,
    ...(app.allTools.some((tool) => tool.cache || tool.sync)
      ? [
          `Local data:`,
          ...line("  data", "what is kept on this machine, and where"),
          ...(app.allTools.some((tool) => tool.sync)
            ? [
                ...line("  data sync <command>", "copy every page of a list to this machine"),
                ...line("  data search <words>", "search synced records offline (--in <command>)"),
                ...line('  data sql "<select>"', "query local data with read-only SQL"),
              ]
            : []),
          ...line("  data clear [<command>]", "delete this account's local data (--cache for cached results only)"),
          ``,
        ]
      : []),
    `Output flags, on any command:`,
    ...GLOBAL_FLAGS.flatMap(([flag, help]) => line(`  ${flag}`, help)),
    ``,
    ...(app.definition.settings?.length
      ? [`${app.title} settings:`, ...app.definition.settings.flatMap((setting) => line(`  ${setting.env}`, setting.description)), ``]
      : []),
    `Settings:`,
    ...line(`  ${names.readOnly}=1`, "hide and refuse every write"),
    ...line(`  ${names.allowDestructive}=0`, "keep writes, refuse the irreversible ones"),
    ...line(`  ${names.toolsets}=a,b`, "only these toolsets (or all)"),
    ...line(`  ${names.surface}=search`, "MCP lists three tools that find, describe and run the rest"),
    ...line(`  ${names.auditLog}=<file>`, "append every attempted write to this file"),
    ...line(`  ${names.toolTimeoutMs}=<ms>`, "give up on any tool after this long"),
    ...line(`  ${names.confirm}=model`, "let confirm: true alone confirm, for an agent with no person to ask"),
    ...(app.allTools.some((tool) => tool.cache) ? line(`  ${names.cache}=0`, "never answer from the local cache") : []),
    ...(app.allTools.some((tool) => tool.cache || tool.sync) ? line(`  ${names.dataDir}=<dir>`, "keep local data in this folder") : []),
    ``,
    `Exit codes:`,
    `  ${EXIT.ok} ok   ${EXIT.usage} usage or refused write   ${EXIT.notFound} not found   ${EXIT.auth} auth   ${EXIT.api} API   ${EXIT.rateLimited} rate limited   ${EXIT.notConfigured} nothing configured`,
    ``,
  ];
  if (app.definition.links?.repository) lines.push(app.definition.links.repository, ``);
  return lines.join("\n");
}

/** One line per tool, for search results and listings. */
export function toolLine(tool: Tool): string {
  return `${riskMark(tool.risk)} ${tool.command}  ${tool.title}: ${firstSentence(tool.description, 80)}`;
}
