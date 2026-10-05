/**
 * Serving an app over stdio, which every local client launches, or HTTP.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { stderrLogger, type App, type ServeSession } from "./app.js";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Logger } from "./tool.js";
import { UsageError } from "./errors.js";

/**
 * Serve over stdio.
 *
 * The setup check runs after the server is already answering. A client gives a
 * server a few seconds to start, and a server that waits on a slow check, or
 * exits because nothing is configured yet, shows up as broken instead of as a
 * set of tools that explain what to configure.
 */
export async function serveStdioApp(app: App, env: NodeJS.ProcessEnv): Promise<void> {
  const log = stderrLogger(app.envPrefix, env);
  let server: McpServer | undefined;
  const handle = serveStdio(() => (server = app.createServer(env)));

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void handle.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  void afterStart(app, env, log, sessionOf(() => server));
}

/** The session `onServe` gets: `notify` writes to the server stdio is serving, once it has one. */
export function sessionOf(current: () => McpServer | undefined): ServeSession {
  return {
    async notify(method, params) {
      const server = current();
      if (!server) return false;
      await server.server.notification({ method, ...(params ? { params } : {}) } as Parameters<McpServer["server"]["notification"]>[0]);
      return true;
    },
  };
}

/** Over HTTP no session is waiting for a notification, so `notify` sends nothing. */
const NO_SESSION: ServeSession = { notify: async () => false };

/**
 * Once the server is answering: say if nothing is configured, then run the
 * app's `onServe`. Nothing here can hold up the handshake or stop the server.
 */
export async function afterStart(app: App, env: NodeJS.ProcessEnv, log: Logger, session: ServeSession = NO_SESSION): Promise<void> {
  let ctx: unknown;
  try {
    ctx = await app.context(env);
    if (app.definition.configured && !(await app.definition.configured(ctx))) {
      log.warn(`Nothing is configured yet. Tools that need an account will say what is missing. Run \`${app.bins.cli} doctor\`.`);
    }
  } catch (error) {
    log.warn(`Setup is incomplete: ${(error as Error).message} Run \`${app.bins.cli} doctor\`.`);
    return;
  }
  try {
    await app.definition.onServe?.(ctx, log, session);
  } catch (error) {
    log.warn(app.secrets.redact((error as Error)?.message ?? String(error)));
  }
}

export type HttpOptions = {
  host: string;
  port: number;
  token?: string;
  /** Browser origins beyond localhost that may call the server, from `<PREFIX>_HTTP_ALLOWED_ORIGINS`. */
  allowedOrigins?: readonly string[];
};

export function httpOptions(app: App, env: NodeJS.ProcessEnv, argv: string[]): HttpOptions {
  const at = argv.findIndex((token) => token === "--port" || token.startsWith("--port="));
  const raw = at === -1 ? env[`${app.envPrefix}_HTTP_PORT`] : argv[at]!.includes("=") ? argv[at]!.split("=")[1] : argv[at + 1];
  const port = Number(raw ?? app.definition.httpPort ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError(`--port expects a port number, got '${raw}'.`);
  return {
    host: env[`${app.envPrefix}_HTTP_HOST`]?.trim() || "127.0.0.1",
    port,
    token: env[`${app.envPrefix}_HTTP_TOKEN`]?.trim() || undefined,
    allowedOrigins: (env[`${app.envPrefix}_HTTP_ALLOWED_ORIGINS`] ?? "")
      .split(",")
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter(Boolean),
  };
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function localOrigin(origin: string): boolean {
  try {
    return LOOPBACK.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * Serve over Streamable HTTP, for a machine that is always on.
 *
 * Bound to 127.0.0.1 by default. The server acts with whatever account it was
 * given, so it refuses to listen anywhere else without a bearer token rather
 * than trusting that nobody will find the port.
 */
export async function serveHttpApp(app: App, env: NodeJS.ProcessEnv, options: HttpOptions): Promise<{ close: () => Promise<void>; url: string }> {
  const loopback = LOOPBACK.has(options.host);
  if (!loopback && !options.token) {
    throw new UsageError(
      `Refusing to listen on ${options.host} without ${app.envPrefix}_HTTP_TOKEN. Anyone who can reach the port would act as your account.`,
    );
  }
  const log = stderrLogger(app.envPrefix, env);
  const handler = createMcpHandler(() => app.createServer(env));

  const server = createServer((req, res) => {
    void handle(app, handler.fetch, options, loopback, req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: (error as Error)?.message ?? "internal error" }, id: null }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });
  // Port 0 asks the system for a free port, so the real one is read back after listening.
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : options.port;
  const url = `http://${options.host.includes(":") && !options.host.startsWith("[") ? `[${options.host}]` : options.host}:${port}/mcp`;
  log.info(`listening on ${url}${options.token ? " (bearer token required)" : ""}`);
  void afterStart(app, env, log);

  return {
    url,
    close: async () => {
      await handler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function handle(
  app: App,
  fetchMcp: (request: Request) => Promise<Response>,
  options: HttpOptions,
  loopback: boolean,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // A page in a browser can make requests to localhost. Checking the Host header
  // stops a site that resolves its own name to 127.0.0.1 from reaching this server.
  if (loopback && !LOOPBACK.has(url.hostname)) {
    res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "forbidden host" }));
    return;
  }

  // The MCP transport spec asks every server to check Origin: a page on another
  // site can send a request here that a browser lets through, and only the
  // Origin header says where it came from. Clients that are not browsers send none.
  const origin = req.headers.origin;
  if (origin && !localOrigin(origin) && !(options.allowedOrigins ?? []).includes(origin.replace(/\/$/, ""))) {
    res.writeHead(403, { "content-type": "application/json" }).end(
      JSON.stringify({ error: `Origin ${origin} is not allowed. Add it to ${app.envPrefix}_HTTP_ALLOWED_ORIGINS if this is deliberate.` }),
    );
    return;
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, name: app.name, version: app.version, tools: app.tools().length }));
    return;
  }
  if (url.pathname !== "/mcp") {
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
    return;
  }
  if (options.token && req.headers.authorization !== `Bearer ${options.token}`) {
    res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" }).end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  const controller = new AbortController();
  res.on("close", () => controller.abort());
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else if (value !== undefined) headers.set(key, value);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const request = new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>) : undefined,
    signal: controller.signal,
    duplex: "half",
  } as RequestInit);

  const response = await fetchMcp(request);
  const out: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    out[key] = value;
  });
  res.writeHead(response.status, out);
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
}
