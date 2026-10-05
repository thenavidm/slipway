/**
 * What a person running the server decides, read from the environment.
 *
 * The person who installs a server is not always the person who wrote it, and
 * the switches that matter to them are the same on every server: hide writes,
 * block the irreversible ones, keep a log, load fewer tools. They live under
 * the server's own prefix, so two servers in one client never share a switch.
 */

import type { Risk, Surface, Tool } from "./tool.js";

export type ToolSurface = "full" | "search";

/**
 * Who confirms a call that needs confirmation.
 *
 * - `human`: a person, wherever the client can ask one. Claude Code shows its
 *   own approval prompt, other clients that support elicitation show an
 *   approval form, and only a client that can do neither falls back to the
 *   model passing `confirm: true`.
 * - `model`: `confirm: true` from the model is enough. For a headless agent
 *   with no person to ask.
 */
export type ConfirmMode = "human" | "model";

export type Policy = {
  readOnly: boolean;
  /** Read-only because the server is by default and nothing set `<PREFIX>_READ_ONLY`, so the way out is setting it to 0. */
  readOnlyByDefault: boolean;
  allowDestructive: boolean;
  /** Irreversible writes off because the server keeps them off by default and nothing set `<PREFIX>_ALLOW_DESTRUCTIVE`. */
  destructiveOffByDefault: boolean;
  auditLog?: string;
  /** `all`, or the toolsets that are on. Tools with no tags are always on. */
  toolsets: "all" | ReadonlySet<string>;
  /** `search` replaces the tool list with three tools that find, describe and call the rest. */
  surface: ToolSurface;
  toolTimeoutMs?: number;
  confirm: ConfirmMode;
  /** Whether reads that opted in may answer from the local cache. */
  cache: boolean;
  /** Whether the irreversible tools and paid calls are left out of the list, not only refused. */
  hideDestructive: boolean;
};

export type PolicyDefaults = {
  /**
   * The toolsets on when `<PREFIX>_TOOLSETS` is unset. A function receives the
   * environment, so a server can keep an older switch working, such as a
   * `<PREFIX>_ENABLE_BETA=1` that predates toolsets, and the surface asking,
   * so a server whose older switch only decided what an MCP client loads can
   * leave its terminal running every command.
   */
  toolsets?: readonly string[] | "all" | ((env: NodeJS.ProcessEnv, on: Surface) => readonly string[] | "all");
  surface?: ToolSurface;
  confirm?: ConfirmMode;
  /**
   * What `<PREFIX>_ALLOW_DESTRUCTIVE=0` does to the irreversible tools and paid
   * calls: `refuse` each call (the default), or `hide` them from the list, as
   * read-only mode hides every write. A server that hid them before it moved
   * keeps doing so.
   */
  destructiveOff?: "refuse" | "hide";
  /**
   * Whether writes are off when `<PREFIX>_READ_ONLY` is unset. False unless the
   * server was read-only by default before it moved. A function receives the
   * environment, so an older switch keeps working, such as a
   * `<PREFIX>_ALLOW_WRITE=true` that turned writes on, and the surface asking,
   * as for `toolsets`.
   */
  readOnly?: boolean | ((env: NodeJS.ProcessEnv, on: Surface) => boolean);
  /**
   * Whether irreversible writes are on when `<PREFIX>_ALLOW_DESTRUCTIVE` is
   * unset. True unless the server kept them off by default. A function
   * receives the environment and the surface, as for `readOnly`.
   */
  allowDestructive?: boolean | ((env: NodeJS.ProcessEnv, on: Surface) => boolean);
};

export type PolicyEnv = {
  readOnly: string;
  allowDestructive: string;
  auditLog: string;
  toolsets: string;
  surface: string;
  toolTimeoutMs: string;
  confirm: string;
  cache: string;
  dataDir: string;
};

/**
 * Which of the write switches can change anything for these tools. A server
 * whose tools all read has nothing for read-only mode to hide or the audit log
 * to record, and one with no irreversible, paid or confirmed call has nothing
 * for the destructive and confirm switches to act on, so help, agent-context
 * and the generated docs leave those out. They still work if set.
 */
export function switchesThatApply(tools: readonly Tool[]): { readOnly: boolean; allowDestructive: boolean; auditLog: boolean; confirm: boolean } {
  const writes = tools.some((tool) => tool.risk !== "read");
  return {
    readOnly: writes,
    allowDestructive: tools.some((tool) => tool.risk === "destructive" || tool.spends),
    auditLog: writes,
    confirm: tools.some((tool) => tool.requireConfirm),
  };
}

export function policyEnvNames(prefix: string): PolicyEnv {
  return {
    readOnly: `${prefix}_READ_ONLY`,
    allowDestructive: `${prefix}_ALLOW_DESTRUCTIVE`,
    auditLog: `${prefix}_AUDIT_LOG`,
    toolsets: `${prefix}_TOOLSETS`,
    surface: `${prefix}_SURFACE`,
    toolTimeoutMs: `${prefix}_TOOL_TIMEOUT_MS`,
    confirm: `${prefix}_CONFIRM`,
    cache: `${prefix}_CACHE`,
    dataDir: `${prefix}_DATA_DIR`,
  };
}

const TRUE = /^(1|true|yes|on)$/i;
const FALSE = /^(0|false|no|off)$/i;

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (TRUE.test(value.trim())) return true;
  if (FALSE.test(value.trim())) return false;
  return fallback;
}

/** Whether a switch was set to something `flag` reads, rather than left to the default. */
function isSet(value: string | undefined): boolean {
  return value !== undefined && (TRUE.test(value.trim()) || FALSE.test(value.trim()));
}

/**
 * How messages name the read-only and irreversible-write switches: the setting
 * that turned writes off, or, on a server that is off by default, the one that
 * turns them on. "Unset X" is wrong advice when nothing set X.
 */
export function switchWords(policy: Pick<Policy, "readOnlyByDefault" | "destructiveOffByDefault">, names: PolicyEnv) {
  return {
    /** Why a write is off: "this server is running with X_READ_ONLY=1". */
    readOnly: policy.readOnlyByDefault ? `this server is read-only until ${names.readOnly}=0 is set` : `this server is running with ${names.readOnly}=1`,
    readOnlyFix: policy.readOnlyByDefault ? `Set ${names.readOnly}=0 to allow writes.` : `Unset ${names.readOnly} to allow writes.`,
    readOnlyHides: policy.readOnlyByDefault ? `hidden until ${names.readOnly}=0 is set` : `hidden by ${names.readOnly}=1`,
    /** Why an irreversible write is off. */
    destructive: policy.destructiveOffByDefault
      ? `irreversible writes are off until ${names.allowDestructive}=1 is set`
      : `this server is running with ${names.allowDestructive}=0`,
    destructiveFix: (what: string) => (policy.destructiveOffByDefault ? `Set ${names.allowDestructive}=1 to allow ${what}.` : `Unset ${names.allowDestructive} to allow ${what}.`),
    destructiveHides: policy.destructiveOffByDefault ? `hidden until ${names.allowDestructive}=1 is set` : `hidden by ${names.allowDestructive}=0`,
  };
}

/** The policy on one surface: the defaults may differ between an MCP client and the terminal, and a variable that is set applies to both. */
export function readPolicy(env: NodeJS.ProcessEnv, prefix: string, defaults: PolicyDefaults = {}, on: Surface = "mcp"): Policy {
  const names = policyEnvNames(prefix);
  const rawToolsets = env[names.toolsets]?.trim();
  const fromDefaults = (typeof defaults.toolsets === "function" ? defaults.toolsets(env, on) : defaults.toolsets) ?? "all";
  const toolsets: Policy["toolsets"] =
    rawToolsets === undefined || rawToolsets === ""
      ? fromDefaults === "all"
        ? "all"
        : new Set(fromDefaults)
      : rawToolsets.toLowerCase() === "all"
        ? "all"
        : new Set(
            rawToolsets
              .split(",")
              .map((part) => part.trim().toLowerCase())
              .filter(Boolean),
          );
  const surface = env[names.surface]?.trim().toLowerCase();
  const timeout = Number(env[names.toolTimeoutMs]);
  const confirm = env[names.confirm]?.trim().toLowerCase();
  const byDefault = (value: boolean | ((env: NodeJS.ProcessEnv, on: Surface) => boolean) | undefined, otherwise: boolean): boolean =>
    value === undefined ? otherwise : typeof value === "function" ? value(env, on) : value;
  const allowDestructive = flag(env[names.allowDestructive], byDefault(defaults.allowDestructive, true));
  const readOnly = flag(env[names.readOnly], byDefault(defaults.readOnly, false));
  return {
    readOnly,
    readOnlyByDefault: readOnly && !isSet(env[names.readOnly]),
    allowDestructive,
    destructiveOffByDefault: !allowDestructive && !isSet(env[names.allowDestructive]),
    auditLog: env[names.auditLog]?.trim() || undefined,
    toolsets,
    surface: surface === "search" || surface === "full" ? surface : (defaults.surface ?? "full"),
    toolTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
    confirm: confirm === "human" || confirm === "model" ? confirm : (defaults.confirm ?? "human"),
    cache: flag(env[names.cache], true),
    hideDestructive: !allowDestructive && defaults.destructiveOff === "hide",
  };
}

export type Visibility = { visible: true } | { visible: false; reason: "read-only" | "destructive" | "toolset" };

/** Whether a tool is on under this policy, and if not, why, so a refusal can say how to turn it on. */
export function visibility(tool: Pick<Tool, "risk" | "tags"> & { spends?: boolean; whenReadOnly?: "reads" }, policy: Policy): Visibility {
  if (policy.readOnly && tool.risk !== "read" && tool.whenReadOnly !== "reads") return { visible: false, reason: "read-only" };
  if (policy.hideDestructive && (tool.risk === "destructive" || tool.spends === true)) return { visible: false, reason: "destructive" };
  if (policy.toolsets !== "all" && tool.tags.length > 0) {
    const on = policy.toolsets;
    if (!tool.tags.some((tag) => on.has(tag))) return { visible: false, reason: "toolset" };
  }
  return { visible: true };
}

export function riskMark(tool: { risk: Risk; spends?: boolean }): string {
  return tool.spends ? "$" : tool.risk === "read" ? " " : tool.risk === "destructive" ? "!" : "*";
}
