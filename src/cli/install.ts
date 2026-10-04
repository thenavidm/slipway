/**
 * `install <client>` from a terminal: plan the change, show it, make it.
 */

import type { App, CliIO } from "../app.js";
import { EXIT, UsageError } from "../errors.js";
import { applyInstall, CLIENTS, planInstall, type ClientId, type InstallPlan, type Scope } from "../install.js";
import type { Format } from "./output.js";

function value(tokens: string[], name: string): string | undefined {
  const at = tokens.findIndex((token) => token === name || token.startsWith(`${name}=`));
  if (at === -1) return undefined;
  const token = tokens[at]!;
  const found = token.includes("=") ? token.slice(name.length + 1) : tokens[at + 1];
  if (found === undefined || found.startsWith("--")) throw new UsageError(`${name} expects a value.`);
  return found;
}

function describe(plan: InstallPlan): string {
  const lines: string[] = [];
  if (plan.run) lines.push(`  ${[plan.run.command, ...plan.run.args.map((arg) => (/^[A-Za-z0-9_./:@=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`))].join(" ")}`);
  else lines.push(...(typeof plan.entry === "string" ? plan.entry : JSON.stringify({ [plan.name]: plan.entry }, null, 2)).split("\n").map((line) => `  ${line}`));
  return lines.join("\n");
}

export async function runInstall(app: App, io: CliIO, tokens: string[], options: { agent: boolean; dryRun: boolean; format: Format }): Promise<number> {
  const client = tokens.find((token) => !token.startsWith("--") && !["--scope", "--name"].includes(tokens[tokens.indexOf(token) - 1] ?? "")) as ClientId | undefined;
  const ids = Object.keys(CLIENTS) as ClientId[];
  if (!client || !ids.includes(client)) {
    throw new UsageError(`install expects one of: ${ids.join(", ")}.`, { hint: `${io.bin} install codex --dry-run shows the change without making it.` });
  }
  const scope = (value(tokens, "--scope") ?? CLIENTS[client].scopes[0]!) as Scope;
  if (scope !== "user" && scope !== "project") throw new UsageError(`--scope expects user or project, got '${scope}'.`);
  const name = value(tokens, "--name") ?? app.name;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new UsageError("--name expects letters, digits, '-' or '_'.");

  const plan = planInstall(
    app,
    { client, scope, name, copyEnv: tokens.includes("--copy-env"), local: tokens.includes("--local") },
    { env: io.env, cwd: io.cwd ?? process.cwd() },
  );
  const title = CLIENTS[client].title;
  const machine = options.agent || options.format !== "auto";

  if (options.dryRun) {
    if (machine) io.stdout(`${JSON.stringify({ dry_run: true, ...plan, text: undefined })}\n`);
    else {
      const where = plan.run ? "would run" : `would write ${plan.file}`;
      io.stdout([``, `${title} (${scope}): ${where}`, ``, describe(plan), ``, ...plan.notes.map((note) => `${note}`), ``].join("\n"));
    }
    return EXIT.ok;
  }

  const result = await applyInstall(plan, io);
  if (result.ran && result.ran.code !== 0) {
    const missing = result.ran.code === 127;
    const exists = /already exists/i.test(result.ran.output);
    throw new UsageError(
      missing ? "The claude command is not on PATH, so nothing was added." : exists ? `${name} is already in Claude Code (${scope}).` : `claude mcp add-json failed: ${result.ran.output}`,
      { hint: missing ? `Install Claude Code, or run it yourself:\n${describe(plan)}` : exists ? `Remove it first with \`claude mcp remove ${name} --scope ${scope}\`, then run install again.` : undefined },
    );
  }

  if (machine) {
    io.stdout(`${JSON.stringify({ installed: true, client, scope, name, ...(plan.file ? { file: plan.file } : {}), ...(result.backup ? { backup: result.backup } : {}), env: plan.env, notes: plan.notes })}\n`);
  } else {
    const lines = [``, `Added ${name} to ${title} (${scope})${plan.file ? `: ${plan.file}` : "."}`];
    if (result.backup) lines.push(`The previous file is saved as ${result.backup}.`);
    lines.push(``, describe(plan), ``, ...plan.notes, `Restart ${title} to load it.`, ``);
    io.stdout(lines.join("\n"));
  }
  return EXIT.ok;
}
