import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { slipway } from "../src/index.js";
import { httpOptions, serveHttpApp } from "../src/serve.js";
import { createApp } from "./fixtures/notes.js";

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const json = text.startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").find((line) => line.startsWith("data:"))!.slice(5));
  return { status: response.status, json };
}

describe("HTTP transport", () => {
  it("answers a 2025-era client over Streamable HTTP", async () => {
    const served = await serveHttpApp(createApp(), {}, { host: "127.0.0.1", port: 0 });
    close = served.close;
    const { status, json } = await post(served.url, initialize);
    expect(status).toBe(200);
    expect(json.result.serverInfo).toMatchObject({ name: "notes" });
    const health = await (await fetch(served.url.replace("/mcp", "/health"))).json();
    expect(health).toMatchObject({ ok: true, name: "notes", tools: 9 });
  });

  it("requires the bearer token when one is set", async () => {
    const served = await serveHttpApp(createApp(), {}, { host: "127.0.0.1", port: 0, token: "t0ken-value" });
    close = served.close;
    expect((await fetch(served.url, { method: "POST", body: "{}" })).status).toBe(401);
    const { status } = await post(served.url, initialize, { authorization: "Bearer t0ken-value" });
    expect(status).toBe(200);
  });

  it("refuses a request whose Host is not the loopback it is bound to", async () => {
    const served = await serveHttpApp(createApp(), {}, { host: "127.0.0.1", port: 0 });
    close = served.close;
    const { port } = new URL(served.url);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { host: "evil.example", "content-type": "application/json" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end(JSON.stringify(initialize));
    });
    expect(status).toBe(403);
  });

  it("will not listen on a public address without a token", async () => {
    await expect(serveHttpApp(createApp(), {}, { host: "0.0.0.0", port: 0 })).rejects.toThrow(/without NOTES_HTTP_TOKEN/);
  });

  it("keeps a port the server already shipped as its default, under the variable and the flag", () => {
    const shipped = slipway({ name: "pods", version: "1.0.0", httpPort: 8000, context: () => ({}), tools: [] });
    expect(httpOptions(createApp(), {}, []).port).toBe(8787);
    expect(httpOptions(shipped, {}, []).port).toBe(8000);
    expect(httpOptions(shipped, { PODS_HTTP_PORT: "9100" }, []).port).toBe(9100);
    expect(httpOptions(shipped, { PODS_HTTP_PORT: "9100" }, ["--http", "--port=9200"]).port).toBe(9200);
  });
});

describe("onServe", () => {
  it("runs once the server is answering, with the context, and a throw only logs", async () => {
    const seen: unknown[] = [];
    const app = slipway({ name: "queue", version: "1.0.0", context: () => ({ queue: "notes" }), tools: [], onServe: (ctx) => void seen.push(ctx) });
    const served = await serveHttpApp(app, {}, { host: "127.0.0.1", port: 0 });
    close = served.close;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toEqual([{ queue: "notes" }]);

    const failing = slipway({ name: "queue", version: "1.0.0", context: () => ({}), tools: [], onServe: () => { throw new Error("queue file is unreadable"); } });
    const second = await serveHttpApp(failing, {}, { host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await fetch(second.url.replace("/mcp", "/health"))).status).toBe(200);
    await second.close();
  });

  it("never runs for a CLI command", async () => {
    let served = 0;
    const app = slipway({ name: "queue", version: "1.0.0", context: () => ({}), tools: [], onServe: () => void served++ });
    await app.runCli(["--version"], { stdout: () => undefined, stderr: () => undefined, stdin: async () => "", env: {}, isTTY: false, bin: app.bins.cli });
    await app.runCli(["doctor"], { stdout: () => undefined, stderr: () => undefined, stdin: async () => "", env: {}, isTTY: false, bin: app.bins.cli });
    expect(served).toBe(0);
  });
});
