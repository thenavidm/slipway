/**
 * What a person running the server decides, read from the environment.
 *
 * The person who installs a server is not always the person who wrote it, and
 * the switches that matter to them are the same on every server: hide writes,
 * block the irreversible ones, keep a log, load fewer tools. They live under
 * the server's own prefix, so two servers in one client never share a switch.
 */

import type { Risk, Tool } from "./tool.js";

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
  allowDestructive: boolean;
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
   * `<PREFIX>_ENABLE_BETA=1` that predates toolsets.
   */
  toolsets?: readonly string[] | "all" | ((env: NodeJS.ProcessEnv) => readonly string[] | "all");
  surface?: ToolSurface;
  confirm?: ConfirmMode;
  /**
   * What `<PREFIX>_ALLOW_DESTRUCTIVE=0` does to the irreversible tools and paid
   * calls: `refuse` each call (the default), or `hide` them from the list, as
   * read-only mode hides every write. A server that hid them before it moved
   * keeps doing so.
   */
  destructiveOff?: "refuse" | "hide";
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

export function readPolicy(env: NodeJS.ProcessEnv, prefix: string, defaults: PolicyDefaults = {}): Policy {
  const names = policyEnvNames(prefix);
  const rawToolsets = env[names.toolsets]?.trim();
  const fromDefaults = (typeof defaults.toolsets === "function" ? defaults.toolsets(env) : defaults.toolsets) ?? "all";
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
  const allowDestructive = flag(env[names.allowDestructive], true);
  return {
    readOnly: flag(env[names.readOnly], false),
    allowDestructive,
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
export function visibility(tool: Pick<Tool, "risk" | "tags"> & { spends?: boolean }, policy: Policy): Visibility {
  if (policy.readOnly && tool.risk !== "read") return { visible: false, reason: "read-only" };
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
