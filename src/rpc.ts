/**
 * A minimal MCP client over an in-memory pair, for checks and tests.
 *
 * It speaks raw JSON-RPC rather than wrapping a full client library, which
 * keeps the client package out of every server's install and shows exactly
 * what a client receives on the wire. The server side is the same stdio entry
 * the binary runs, so both protocol eras are served exactly as a real client
 * reaches them: the 2025 handshake, and the 2026-07-28 revision where every
 * request carries the client's details and a call can come back asking for
 * input before it finishes.
 */

import { InMemoryTransport, type CallToolResult, type McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { stderrLogger, type App } from "./app.js";
import { afterStart, sessionOf } from "./serve.js";

export type ListedTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  icons?: unknown[];
  _meta?: Record<string, unknown>;
};

export type InitializeResult = {
  protocolVersion: string;
  serverInfo: { name: string; version: string; title?: string };
  capabilities: Record<string, unknown>;
  instructions?: string;
};

/** What a server asks a person through the client: a message and the fields of a form. */
export type ElicitRequest = { message: string; requestedSchema?: Record<string, unknown>; mode?: string };
export type ElicitAnswer = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

export type ConnectOptions = {
  /** `legacy` opens with the 2025 handshake, `modern` with the 2026-07-28 revision. */
  era?: "legacy" | "modern";
  /** Who the client says it is. Some behavior depends on it: Claude Code prompts for confirmed tools itself. */
  clientInfo?: { name: string; version: string };
  /**
   * Answer the server's approval forms and other questions, as a person would.
   * Setting it declares that the client can ask a person.
   */
  elicit?: (request: ElicitRequest) => ElicitAnswer | Promise<ElicitAnswer>;
  /** Run the app's `onServe` once connected, as a real stdio server does, so its notifications arrive here. */
  serve?: boolean;
};

export type RpcClient = {
  era: "legacy" | "modern";
  initialize: InitializeResult;
  /** A request, answered and retried for as long as the server asks for input, the way a client does. */
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** One request and the server's first answer, with no retry: for testing what the protocol carries. */
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  listTools(): Promise<ListedTool[]>;
  callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  /** Every notification the server sent this client, in order. */
  notifications: Array<{ method: string; params?: Record<string, unknown> }>;
  close(): Promise<void>;
};

const MODERN = "2026-07-28";
const LEGACY = "2025-11-25";
const KEY = {
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  clientInfo: "io.modelcontextprotocol/clientInfo",
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
  serverInfo: "io.modelcontextprotocol/serverInfo",
} as const;
/** How many times one call may come back asking for input before the client gives up, as the SDK's own client does. */
const MAX_ROUNDS = 8;

type Message = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string; code: number } };

export async function connectInMemory(app: App, env: NodeJS.ProcessEnv = process.env, options: ConnectOptions = {}): Promise<RpcClient> {
  const era = options.era ?? "legacy";
  const clientInfo = options.clientInfo ?? { name: "slipway-check", version: "0" };
  const capabilities: Record<string, unknown> = options.elicit ? { elicitation: { form: {} } } : {};
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  let server: McpServer | undefined;
  const handle = serveStdio(() => (server = app.createServer(env)), { transport: serverSide });
  const notifications: RpcClient["notifications"] = [];

  let nextId = 0;
  const pending = new Map<number | string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  /** What this client answers when the server asks it something, in either era. */
  const answer = async (method: string, params: Record<string, unknown> | undefined): Promise<unknown> => {
    if (method === "elicitation/create" && options.elicit) return options.elicit(params as ElicitRequest);
    if (method === "ping") return {};
    if (method === "roots/list") return { roots: [] };
    throw Object.assign(new Error(`This client does not answer ${method}.`), { code: -32601 });
  };

  clientSide.onmessage = (raw) => {
    const message = raw as Message;
    if (message.method !== undefined) {
      if (message.id === undefined) {
        notifications.push({ method: message.method, ...(message.params ? { params: message.params } : {}) });
        return;
      }
      // A request from the server, which only the 2025 handshake sends this way.
      const id = message.id;
      void answer(message.method, message.params).then(
        (result) => clientSide.send({ jsonrpc: "2.0", id, result: result as Record<string, unknown> }),
        (error: Error & { code?: number }) => clientSide.send({ jsonrpc: "2.0", id, error: { code: error.code ?? -32603, message: error.message } }),
      );
      return;
    }
    if (message.id === undefined || !pending.has(message.id)) return;
    const waiter = pending.get(message.id)!;
    pending.delete(message.id);
    if (message.error) waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    else waiter.resolve(message.result);
  };
  await clientSide.start();

  const envelope = { [KEY.protocolVersion]: MODERN, [KEY.clientInfo]: clientInfo, [KEY.clientCapabilities]: capabilities };
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      const body = era === "modern" ? { ...params, _meta: { ...((params._meta as object | undefined) ?? {}), ...envelope } } : params;
      void clientSide.send({ jsonrpc: "2.0", id, method, params: body });
    });

  type Reply = { resultType?: string; inputRequests?: Record<string, { method: string; params?: Record<string, unknown> }>; requestState?: string };

  /** A request, retried with answers for as long as the server comes back asking for input. */
  const request = async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    let result = (await send(method, params)) as Reply;
    for (let round = 0; result?.resultType === "input_required"; round++) {
      if (round >= MAX_ROUNDS) throw new Error(`${method} still asked for input after ${MAX_ROUNDS} rounds.`);
      const inputResponses: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(result.inputRequests ?? {})) {
        inputResponses[key] = await answer(entry.method, entry.params);
      }
      result = (await send(method, { ...params, inputResponses, ...(result.requestState === undefined ? {} : { requestState: result.requestState }) })) as Reply;
    }
    return result;
  };

  let initialize: InitializeResult;
  if (era === "modern") {
    const found = (await send("server/discover")) as { capabilities?: Record<string, unknown>; instructions?: string; _meta?: Record<string, unknown> };
    initialize = {
      protocolVersion: MODERN,
      serverInfo: (found._meta?.[KEY.serverInfo] as InitializeResult["serverInfo"] | undefined) ?? { name: "", version: "" },
      capabilities: found.capabilities ?? {},
      ...(found.instructions === undefined ? {} : { instructions: found.instructions }),
    };
  } else {
    initialize = (await send("initialize", { protocolVersion: LEGACY, capabilities, clientInfo })) as InitializeResult;
    await clientSide.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  if (options.serve) void afterStart(app, env, stderrLogger(app.envPrefix, env), sessionOf(() => server));

  return {
    era,
    initialize,
    request,
    send,
    notifications,
    async listTools() {
      const tools: ListedTool[] = [];
      let cursor: string | undefined;
      do {
        const page = (await request("tools/list", cursor ? { cursor } : {})) as { tools: ListedTool[]; nextCursor?: string };
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    },
    async callTool(name, args = {}) {
      return (await request("tools/call", { name, arguments: args })) as CallToolResult;
    },
    async close() {
      await handle.close();
      await clientSide.close().catch(() => undefined);
    },
  };
}
