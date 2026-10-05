/**
 * Reference documentation generated from the tool list.
 *
 * A hand-written table of tools and arguments goes stale the day a tool is
 * added. This one is printed from the same definitions the server and CLI use,
 * so pasting it into a README is the last time anyone edits it by hand.
 */

import type { App } from "./app.js";
import { flagsFor } from "./cli/flags.js";
import { exampleCommand } from "./cli/help.js";
import { policyEnvNames } from "./policy.js";
import type { Tool } from "./tool.js";

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim() || "None";
}

function riskWords(tool: Tool): string {
  const base = tool.risk === "read" ? "Read" : tool.risk === "write" ? "Write" : "Irreversible";
  return tool.requireConfirm ? `${base}, needs confirm` : base;
}

export function toolTable(app: App, tools: readonly Tool[]): string {
  const lines = ["| Command | What it does | Risk |", "|---|---|---|"];
  for (const tool of tools) lines.push(`| \`${tool.command}\` | ${cell(tool.title)} | ${riskWords(tool)} |`);
  return lines.join("\n");
}

export function toolReference(app: App, tools: readonly Tool[], heading = "###"): string {
  const sections: string[] = [];
  for (const tool of tools) {
    const flags = flagsFor(tool.jsonSchema).filter((flag) => flag.key !== "confirm");
    const lines = [`${heading} \`${tool.command}\``, ``, `**${cell(tool.title)}.** ${tool.description}`, ``];
    if (flags.length) {
      lines.push("| Argument | Type | Required | Description |", "|---|---|---|---|");
      for (const flag of flags) {
        const type = flag.choices ? flag.choices.map((choice) => `\`${choice}\``).join(", ") : flag.repeatable ? `${flag.kind} list` : flag.kind;
        lines.push(`| \`${flag.key}\` | ${type} | ${flag.required ? "Yes" : "No"} | ${cell(flag.help)} |`);
      }
      lines.push(``);
    }
    lines.push(`Risk: ${riskWords(tool)}.`, ``);
    if (tool.examples.length) {
      lines.push("```bash");
      for (const example of tool.examples) lines.push(`# ${example.description}`, exampleCommand(app.bins.cli, tool, example.args));
      lines.push("```", ``);
    }
    sections.push(lines.join("\n"));
  }
  return sections.join("\n");
}

export function settingsTable(app: App): string {
  const names = policyEnvNames(app.envPrefix);
  return [
    "| Variable | What it does |",
    "|---|---|",
    ...(app.definition.settings ?? []).map((setting) => `| \`${setting.env}\` | ${cell(setting.description)}${setting.secret ? " Keep it private." : ""} |`),
    `| \`${names.readOnly}=1\` | Hide and refuse every write |`,
    `| \`${names.allowDestructive}=0\` | Keep writes, refuse the public or irreversible ones${app.allTools.some((tool) => tool.spends) ? " and paid calls" : ""} |`,
    `| \`${names.toolsets}\` | Comma-separated toolsets to turn on, or \`all\` |`,
    `| \`${names.surface}=search\` | List three tools that find, describe and run the rest |`,
    `| \`${names.auditLog}\` | File that records every attempted write |`,
    `| \`${names.toolTimeoutMs}\` | Give up on any tool after this many milliseconds |`,
    `| \`${names.confirm}=model\` | Let \`confirm: true\` alone confirm a call, for an agent with no person to ask. The default, \`human\`, asks a person wherever the client can |`,
  ].join("\n");
}

export function renderDocs(app: App, env: NodeJS.ProcessEnv = process.env): string {
  const tools = app.tools(env);
  return [`## Commands`, ``, toolTable(app, tools), ``, `## Reference`, ``, toolReference(app, tools), `## Settings`, ``, settingsTable(app), ``].join("\n");
}
