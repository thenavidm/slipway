/**
 * Decides whether a write is allowed to run.
 *
 * Shipping no writes is not safety: it hands the work back to a person.
 * Shipping them unguarded is worse. So everything works, the irreversible
 * calls need an explicit confirmation, and one switch removes every write for
 * an agent nobody should trust with them.
 *
 * Agent mode never confirms anything. A flag that turns on JSON output must
 * not also say yes to deleting something, because the agent that sets it is
 * exactly the caller the confirmation exists for.
 */

import { appendFileSync } from "node:fs";
import { RefusedError } from "./errors.js";
import { policyEnvNames, type Policy } from "./policy.js";
import type { Surface, Tool } from "./tool.js";

/**
 * Who confirmed a call.
 *
 * - `flag`: the caller passed `confirm: true` or `--confirm`.
 * - `person`: a person approved it in a form the client showed.
 * - `client`: the client showed its own approval prompt for this exact call.
 */
export type ConfirmedBy = "flag" | "person" | "client";

export type GuardOutcome =
  | "allowed"
  | "dry-run"
  | "asked a person"
  | "blocked: read-only"
  | "blocked: destructive disabled"
  | "blocked: no confirm"
  | "blocked: person declined"
  | "blocked: no answer"
  | "blocked: approval invalid";

export class Guard {
  constructor(
    private readonly policy: Policy,
    private readonly surface: Surface,
    private readonly prefix: string,
  ) {}

  /** What the caller can actually type to confirm. A model reads `confirm: true`, a person types `--confirm`. */
  get confirmFlag(): string {
    return this.surface === "cli" ? "--confirm" : "confirm: true";
  }

  /**
   * The checks that do not depend on confirmation: read-only mode and the
   * switch for irreversible writes. Run before asking a person, so nobody is
   * asked to approve a call that would be refused anyway.
   */
  preflight(tool: Tool, summary: string): void {
    if (tool.risk === "read" && !tool.requireConfirm) return;
    const names = policyEnvNames(this.prefix);

    if (this.policy.readOnly && tool.risk !== "read") {
      this.record(tool, summary, "blocked: read-only");
      throw new RefusedError(`${tool.name} is unavailable: this server is running with ${names.readOnly}=1.`, {
        hint: `Unset ${names.readOnly} to allow writes.`,
      });
    }

    if (tool.risk === "destructive" && !this.policy.allowDestructive) {
      this.record(tool, summary, "blocked: destructive disabled");
      throw new RefusedError(`${tool.name} is unavailable: this server is running with ${names.allowDestructive}=0.`, {
        hint: `Unset ${names.allowDestructive} to allow irreversible writes.`,
      });
    }
  }

  check(tool: Tool, options: { confirmedBy?: ConfirmedBy; dryRun: boolean; summary: string }): void {
    if (tool.risk === "read" && !tool.requireConfirm) return;
    this.preflight(tool, options.summary);

    if (options.dryRun) {
      this.record(tool, options.summary, "dry-run");
      return;
    }

    if (tool.requireConfirm && !options.confirmedBy) {
      this.record(tool, options.summary, "blocked: no confirm");
      throw new RefusedError(
        `${tool.name} ${consequence(tool)}, so it will not run without ${this.confirmFlag}. About to: ${options.summary}. Call again with ${this.confirmFlag} if that is what was asked for.`,
        { hint: `Pass ${this.confirmFlag} only when the user asked for this exact action.` },
      );
    }

    this.record(tool, options.summary, "allowed", options.confirmedBy);
  }

  /** Append-only record of every attempted write, when an audit log is configured. `started` is a job still running when its call returned. */
  record(tool: Tool, summary: string, outcome: GuardOutcome | "failed" | "done" | "started", confirmedBy?: ConfirmedBy): void {
    if (!this.policy.auditLog) return;
    const line = JSON.stringify({
      at: new Date().toISOString(),
      surface: this.surface,
      tool: tool.name,
      risk: tool.risk,
      summary,
      outcome,
      ...(confirmedBy ? { confirmed_by: confirmedBy } : {}),
    });
    try {
      appendFileSync(this.policy.auditLog, `${line}\n`, { mode: 0o600 });
    } catch {
      // A broken audit log must never take the tool call down with it.
    }
  }
}

/** Why a tool needs confirming, in the words a refusal and an approval form both use. */
export function consequence(tool: Pick<Tool, "risk">): string {
  return tool.risk === "destructive" ? "is public or cannot be undone" : "has an effect that cannot be taken back";
}
