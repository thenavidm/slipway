/**
 * The CLI described to an agent in one read.
 *
 * An agent that has to run `--help` on every command before using one spends a
 * round trip per command. `agent-context` hands it every command, flag, risk,
 * example, exit code and setting at once, as JSON it can act on.
 */

import { createRequire } from "node:module";
import type { App } from "../app.js";
import { EXIT } from "../errors.js";
import { policyEnvNames } from "../policy.js";
import { outputJsonSchema } from "../schema.js";
import { exampleCommand, GLOBAL_FLAGS } from "./help.js";
import { flagsFor } from "./flags.js";

const require = createRequire(import.meta.url);
export const SLIPWAY_VERSION: string = (require("../../package.json") as { version: string }).version;

export const EXIT_MEANINGS: Record<number, string> = {
  [EXIT.ok]: "ok",
  [EXIT.error]: "unexpected error",
  [EXIT.usage]: "usage error, or a write the guard refused",
  [EXIT.notFound]: "not found",
  [EXIT.auth]: "authentication or permission",
  [EXIT.api]: "upstream API error or timeout",
  [EXIT.rateLimited]: "rate limited",
  [EXIT.notConfigured]: "nothing configured",
};

export function agentContext(app: App, env: NodeJS.ProcessEnv, bin: string, options: { brief?: boolean } = {}) {
  const policy = app.policy(env);
  const names = policyEnvNames(app.envPrefix);
  const tools = app.tools(env);
  const hidden = app.allTools.length - tools.length;
  const note = "--agent never confirms a write. A command that requires --confirm runs only when it is passed explicitly.";
  if (options.brief) {
    // Enough to pick a command: what each one is, and which write or need --confirm. The full read adds flags and settings.
    return {
      name: app.name,
      version: app.version,
      ...(app.description ? { description: app.description } : {}),
      usage: { run: `${bin} <command> [flags]`, help: `${bin} <command> --help`, note },
      exit_codes: EXIT_MEANINGS,
      ...(hidden ? { hidden_commands: hidden, ...(app.definition.toolsets ? { toolsets: app.definition.toolsets } : {}) } : {}),
      commands: tools.map((tool) => ({
        command: tool.command,
        title: tool.title,
        ...(tool.risk !== "read" ? { risk: tool.risk } : {}),
        ...(tool.requireConfirm ? { requires_confirm: true } : {}),
      })),
    };
  }
  return {
    name: app.name,
    title: app.title,
    version: app.version,
    framework: { name: "slipway", version: SLIPWAY_VERSION },
    ...(app.description ? { description: app.description } : {}),
    binaries: app.bins,
    usage: {
      run: `${bin} <command> [flags]`,
      help: `${bin} <command> --help`,
      agent_mode: "--agent",
      confirm_flag: "--confirm",
      note,
    },
    exit_codes: EXIT_MEANINGS,
    global_flags: GLOBAL_FLAGS.map(([flag, description]) => ({ flag, description })),
    settings: [
      ...(app.definition.settings ?? []).map((setting) => ({
        env: setting.env,
        set: Boolean(env[setting.env]),
        ...(setting.secret ? { secret: true } : {}),
        description: setting.description,
      })),
      { env: names.readOnly, value: policy.readOnly, description: "hide and refuse every write" },
      { env: names.allowDestructive, value: policy.allowDestructive, description: "allow public or irreversible writes" },
      { env: names.toolsets, value: policy.toolsets === "all" ? "all" : [...policy.toolsets], description: "toolsets that are on" },
      { env: names.surface, value: policy.surface, description: "full tool list, or search for very large catalogs" },
      { env: names.auditLog, value: policy.auditLog ?? null, description: "file that records every attempted write" },
      { env: names.toolTimeoutMs, value: policy.toolTimeoutMs ?? null, description: "deadline for any tool" },
      { env: names.confirm, value: policy.confirm, description: "who confirms a confirmed call over MCP: human asks a person where the client can, model accepts confirm: true" },
      { env: `${app.envPrefix}_HTTP_PORT`, value: env[`${app.envPrefix}_HTTP_PORT`] ?? null, description: "port for --http, 8787 when unset" },
      { env: `${app.envPrefix}_HTTP_HOST`, value: env[`${app.envPrefix}_HTTP_HOST`] ?? null, description: "address for --http, 127.0.0.1 when unset; any other needs a token" },
      { env: `${app.envPrefix}_HTTP_TOKEN`, set: Boolean(env[`${app.envPrefix}_HTTP_TOKEN`]), secret: true, description: "bearer token --http requires" },
      { env: `${app.envPrefix}_DEBUG`, value: /^(1|true|yes)$/i.test(env[`${app.envPrefix}_DEBUG`] ?? ""), description: "print debug lines on stderr" },
    ],
    ...(app.definition.toolsets ? { toolsets: app.definition.toolsets } : {}),
    hidden_commands: hidden,
    commands: tools.map((tool) => ({
      command: tool.command,
      tool: tool.name,
      title: tool.title,
      description: tool.description,
      risk: tool.risk,
      requires_confirm: tool.requireConfirm,
      ...(tool.tags.length ? { toolsets: tool.tags } : {}),
      ...(tool.positional.length ? { positional: tool.positional } : {}),
      flags: flagsFor(tool.jsonSchema)
        .filter((flag) => flag.key !== "confirm")
        .map((flag) => ({
          flag: flag.flag,
          type: flag.kind,
          required: flag.required,
          ...(flag.repeatable ? { repeatable: true } : {}),
          ...(flag.choices ? { choices: flag.choices } : {}),
          ...(flag.default !== undefined ? { default: flag.default } : {}),
          ...(flag.help ? { description: flag.help } : {}),
        })),
      ...(tool.output ? { output_schema: outputJsonSchema(tool.output) } : {}),
      ...(tool.paginate ? { paginates: true } : {}),
      ...(tool.job && !tool.statusOf ? { job: { status_command: `${tool.command}-status`, background: "background" in tool.job } } : {}),
      ...(tool.statusOf ? { checks_jobs_of: tool.statusOf.replace(/_/g, "-") } : {}),
      ...(tool.examples.length
        ? { examples: tool.examples.map((example) => ({ description: example.description, command: exampleCommand(bin, tool, example.args) })) }
        : {}),
    })),
  };
}
