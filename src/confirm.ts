/**
 * Confirmation a model cannot fake.
 *
 * `confirm: true` is something the model types, so on its own it proves only
 * that the model meant it. Where the client can put a person in front of the
 * call, Slipway asks the person instead, and the model's flag stops counting:
 *
 * - Claude Code shows its own approval prompt for a tool marked as needing a
 *   person, on every call and in every permission mode. A call that arrives
 *   from it has already been approved, so nothing else is asked.
 * - Any other client that supports elicitation is sent an approval form. The
 *   tool runs only on an explicit yes.
 * - A client that can do neither falls back to `confirm: true`.
 *
 * An approval form's answer comes back from the client as data, and a client
 * could attach an answer to a call nobody was asked about. So an answer only
 * counts next to the signed state Slipway minted when it asked, which names
 * the exact tool and arguments and can be used once.
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import type { App } from "./app.js";
import { RefusedError } from "./errors.js";
import { consequence, Guard } from "./guard.js";
import type { ConfirmMode } from "./policy.js";
import type { Tool } from "./tool.js";
import { phrase, sha256, stableJson, versionAtLeast } from "./util.js";

/** The key of Slipway's approval form among a call's input requests. */
export const APPROVAL_KEY = "slipway_approval";

/** The client Claude Code identifies as, and the first version known to honor a tool's request for a person. */
const PROMPTING_CLIENT = { name: "claude-code", since: [2, 1, 246] } as const;

export type ClientView = {
  name?: string;
  version?: string;
  capabilities?: Record<string, unknown>;
};

/**
 * Who is calling and what it can do. On the 2026-07-28 revision every request
 * carries this itself; on earlier revisions it was said once, at initialize.
 */
export function clientView(server: McpServer, ctx: ServerContext): ClientView {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const info = (envelope?.[CLIENT_INFO_META_KEY] ?? server.server.getClientVersion()) as { name?: unknown; version?: unknown } | undefined;
  const capabilities = (envelope?.[CLIENT_CAPABILITIES_META_KEY] ?? server.server.getClientCapabilities()) as Record<string, unknown> | undefined;
  return {
    ...(typeof info?.name === "string" ? { name: info.name } : {}),
    ...(typeof info?.version === "string" ? { version: info.version } : {}),
    ...(capabilities ? { capabilities } : {}),
  };
}

/**
 * Whether the client can show a person a form. A bare `elicitation: {}` is the
 * 2025 way of saying so; naming only `url` mode is not.
 */
export function canAskPerson(client: ClientView): boolean {
  const elicitation = client.capabilities?.elicitation;
  if (!elicitation || typeof elicitation !== "object") return false;
  return "form" in elicitation || !("url" in elicitation);
}

/** Whether the client shows its own approval prompt for a tool that asks for a person. */
export function promptsItself(client: ClientView): boolean {
  return client.name === PROMPTING_CLIENT.name && versionAtLeast(client.version, PROMPTING_CLIENT.since);
}

/**
 * How this call gets confirmed.
 *
 * - `client`: the client already asked a person, so the call runs.
 * - `person`: Slipway asks the person with an approval form.
 * - `flag`: the call runs only with `confirm: true`.
 */
export type ConfirmRoute = "client" | "person" | "flag";

export function confirmRoute(mode: ConfirmMode, client: ClientView, listedForPerson: boolean): ConfirmRoute {
  if (mode === "model") return "flag";
  if (listedForPerson && promptsItself(client)) return "client";
  if (canAskPerson(client)) return "person";
  return "flag";
}

type Pending = { t: string; h: string; n: string };

/**
 * Signs the state that travels with an approval form. The key lives as long
 * as the process, which is every round of an approval on stdio and on one
 * HTTP server; state from a restarted process fails verification, and the
 * call is refused rather than run.
 */
const codec = createRequestStateCodec<Pending>({ key: randomBytes(32), ttlSeconds: 600 });

/** For `ServerOptions.requestState.verify`: rejects state Slipway did not sign, or signed more than ten minutes ago. */
export const verifyApprovalState = codec.verify;

/** Nonces of approvals already used, with when each expires. Bounded, so a long-lived server cannot grow it forever. */
const used = new Map<string, number>();
const USED_LIMIT = 10_000;

function useOnce(nonce: string): boolean {
  const now = Date.now();
  if (used.has(nonce)) return false;
  for (const [key, expires] of used) {
    if (expires > now && used.size < USED_LIMIT) break;
    used.delete(key);
  }
  used.set(nonce, now + 11 * 60_000);
  return true;
}

function callHash(tool: string, args: Record<string, unknown>): string {
  return sha256(`${tool}\0${stableJson(args)}`);
}

/**
 * The words and the one field an approval form shows.
 *
 * The field is required, starts unticked, and only an explicit true counts.
 * Accepting is not enough on its own: a client with nobody to ask may accept a
 * form by itself (Codex accepts a form that has no fields), and one that fills
 * in defaults would otherwise approve with them.
 */
export function approvalForm(appTitle: string, tool: Pick<Tool, "risk">, summary: string) {
  return {
    message: `${appTitle} wants to ${phrase(summary)}.\n\nThis ${consequence(tool)}.`,
    requestedSchema: {
      type: "object" as const,
      properties: {
        approve: { type: "boolean" as const, title: "Approve", description: "Tick to run it, then accept. Decline to stop it.", default: false },
      },
      required: ["approve"],
    },
  };
}

/**
 * Ask a person to approve the call, or read their answer.
 *
 * Returns the input-required result to send while the person has not answered
 * yet, and nothing once they approved. Throws a refusal for a no, a closed
 * form, or an answer that does not belong to this exact call.
 */
export async function personApproval<Ctx>(
  app: App<Ctx>,
  tool: Tool<Ctx>,
  rawArgs: Record<string, unknown>,
  ctx: ServerContext,
  env: NodeJS.ProcessEnv,
): Promise<ReturnType<typeof inputRequired> | undefined> {
  const { confirm: _flag, ...args } = rawArgs;
  const guard = new Guard(app.policy(env), "mcp", app.envPrefix);
  const state = ctx.mcpReq.requestState<Pending>();
  const answer = inputResponse(ctx.mcpReq.inputResponses, APPROVAL_KEY);

  // No signed state means nobody was asked yet, whatever answer came along with the call.
  if (!state || typeof state !== "object" || answer.kind === "missing") {
    const summary = app.preflight(tool, rawArgs, { surface: "mcp", env });
    guard.record(tool, summary, "asked a person");
    const form = approvalForm(app.title, tool, summary);
    return inputRequired({
      requestState: await codec.mint({ t: tool.name, h: callHash(tool.name, args), n: randomUUID() }),
      inputRequests: { [APPROVAL_KEY]: inputRequired.elicit(form) },
    });
  }

  const summary = app.preflight(tool, rawArgs, { surface: "mcp", env });
  if (state.t !== tool.name || state.h !== callHash(tool.name, args)) {
    guard.record(tool, summary, "blocked: approval invalid");
    throw new RefusedError(`That approval was for a different call, so ${tool.name} did not run.`, {
      hint: "Call the tool again to ask for a new approval.",
    });
  }
  if (!useOnce(state.n)) {
    guard.record(tool, summary, "blocked: approval invalid");
    throw new RefusedError(`That approval was already used, so ${tool.name} did not run again.`, {
      hint: "Call the tool again to ask for a new approval.",
    });
  }
  if (answer.kind === "elicit" && answer.action === "accept" && answer.content?.approve === true) return undefined;

  if (answer.kind === "elicit" && answer.action === "accept") {
    guard.record(tool, summary, "blocked: person declined");
    throw new RefusedError(`The approval form was accepted without ticking Approve, so ${tool.name} did not run. About to: ${summary}.`, {
      hint: "Ask the user whether they want this, and call again only if they do.",
    });
  }
  if (answer.kind === "elicit" && answer.action === "cancel") {
    guard.record(tool, summary, "blocked: no answer");
    throw new RefusedError(`The approval form was closed without an answer, so ${tool.name} did not run. About to: ${summary}.`, {
      hint: "Ask the user whether they want this, and call again only if they do.",
    });
  }
  guard.record(tool, summary, "blocked: person declined");
  throw new RefusedError(`The approval was declined, so ${tool.name} did not run. About to: ${summary}.`, {
    hint: "Do not call it again unless the user asks for it.",
  });
}
