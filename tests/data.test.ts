import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { matchQuery, searchText, scopeOf } from "../src/data.js";
import { cli, connect } from "../src/testing.js";
import { createApp } from "./fixtures/notes.js";
import { createCatalog, createLibrary, libraryEnv } from "./fixtures/library.js";

const json = (text: string) => JSON.parse(text);

describe("the local cache", () => {
  it("answers a repeated read from this machine, and says how old the answer is", async () => {
    const catalog = createCatalog();
    const env = libraryEnv();
    const mcp = await connect(createLibrary(catalog), { env });
    const first = await mcp.callTool("get_book", { id: "b1" });
    const second = await mcp.callTool("get_book", { id: "b1" });
    await mcp.close();
    expect(catalog.calls).toEqual(["get b1"]);
    expect(first._meta?.["slipway/cache"]).toBeUndefined();
    expect(second._meta?.["slipway/cache"]).toMatchObject({ age_seconds: expect.any(Number) });
    expect(second.structuredContent).toEqual(first.structuredContent);
  });

  it("forgets every cached answer for the account after a write", async () => {
    const catalog = createCatalog();
    const env = libraryEnv();
    const app = createLibrary(catalog);
    await cli(app, ["get-book", "b2"], { env });
    await cli(app, ["rename-book", "--id", "b2", "--title", "Mountain Passes"], { env });
    const after = await cli(app, ["get-book", "b2", "--compact"], { env });
    expect(catalog.calls).toEqual(["get b2", "get b2"]);
    expect(json(after.stdout).title).toBe("Mountain Passes");
  });

  it("can be skipped for one call with --refresh, or switched off", async () => {
    const catalog = createCatalog();
    const env = libraryEnv();
    const app = createLibrary(catalog);
    await cli(app, ["get-book", "b3"], { env });
    await cli(app, ["get-book", "b3", "--refresh"], { env });
    await cli(app, ["get-book", "b3"], { env });
    expect(catalog.calls).toEqual(["get b3", "get b3"]);

    const off = { ...libraryEnv(), LIBRARY_CACHE: "0" };
    await cli(app, ["get-book", "b3"], { env: off });
    await cli(app, ["get-book", "b3"], { env: off });
    expect(catalog.calls).toEqual(["get b3", "get b3", "get b3", "get b3"]);
  });

  it("tells a person at a terminal when an answer came from the cache", async () => {
    const env = libraryEnv();
    const app = createLibrary();
    await cli(app, ["get-book", "b1"], { env, isTTY: true });
    const cached = await cli(app, ["get-book", "b1"], { env, isTTY: true });
    expect(cached.stderr).toContain("from the local cache");
  });

  it("keeps each account's answers apart", async () => {
    const catalog = createCatalog();
    const env = libraryEnv();
    const app = createLibrary(catalog);
    await cli(app, ["get-book", "b4"], { env });
    await cli(app, ["get-book", "b4"], { env: { ...env, LIBRARY_API_KEY: "another-key-987654" } });
    expect(catalog.calls).toEqual(["get b4", "get b4"]);
    expect(scopeOf(["a", "b"])).toBe(scopeOf(["b", "a"]));
    expect(scopeOf([], "user-42")).not.toBe(scopeOf([]));
  });

  it("never writes a credential to disk, and keeps the file readable by its owner only", async () => {
    const env = libraryEnv();
    await cli(createLibrary(), ["get-book", "b1"], { env });
    const file = join(env.LIBRARY_DATA_DIR!, "data.db");
    expect(readFileSync(file).includes(Buffer.from("lib-key-123456"))).toBe(false);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(env.LIBRARY_DATA_DIR!).mode & 0o777).toBe(0o700);
    }
  });

  it("is only opened by an app that uses it", async () => {
    const env = { NOTES_DATA_DIR: "/nonexistent/should-never-be-created" };
    const run = await cli(createApp(), ["create-note", "--title", "x"], { env });
    expect(run.code).toBe(0);
  });
});

describe("synced lists", () => {
  it("copy every page, find records offline, and say where it all lives", async () => {
    const env = libraryEnv();
    const app = createLibrary();
    const sync = json((await cli(app, ["data", "sync", "list-books"], { env })).stdout);
    expect(sync).toMatchObject({ command: "list-books", records: 5, pages: 3, complete: true, filtered: false, removed: 0, skipped: 0 });

    const found = json((await cli(app, ["data", "search", "cafe"], { env })).stdout);
    expect(found.results.map((hit: { id: string }) => hit.id)).toEqual(["b1"]);
    expect(found.results[0].snippet).toContain("[Café]");
    expect(found.results[0].record).toMatchObject({ title: "The Café on the Corner" });

    const prefix = json((await cli(app, ["data", "search", "electr", "--in", "list-books"], { env })).stdout);
    expect(prefix.results.map((hit: { id: string }) => hit.id)).toEqual(["b3"]);

    const status = json((await cli(app, ["data"], { env })).stdout);
    expect(status).toMatchObject({ file: join(env.LIBRARY_DATA_DIR!, "data.db"), can_sync: ["list-books"] });
    expect(status.synced[0]).toMatchObject({ command: "list-books", records: 5, complete: true });
  });

  it("mirror the list on an unfiltered sync, and only add on a filtered one", async () => {
    const catalog = createCatalog();
    const env = libraryEnv();
    const app = createLibrary(catalog);
    await cli(app, ["data", "sync", "list-books"], { env });
    catalog.books = catalog.books.filter((book) => book.id !== "b5");

    const filtered = json((await cli(app, ["data", "sync", "list-books", "--author", "Ana Lima"], { env })).stdout);
    expect(filtered).toMatchObject({ records: 2, filtered: true, removed: 0 });
    expect(json((await cli(app, ["data", "search", "Lisbon"], { env })).stdout).count).toBe(1);

    const full = json((await cli(app, ["data", "sync", "list-books"], { env })).stdout);
    expect(full).toMatchObject({ records: 4, removed: 1 });
    expect(json((await cli(app, ["data", "search", "Lisbon"], { env })).stdout).count).toBe(0);
  });

  it("answer read-only SQL, one statement at a time", async () => {
    const env = libraryEnv();
    const app = createLibrary();
    await cli(app, ["data", "sync", "list-books"], { env });
    const rows = json((await cli(app, ["data", "sql", "select json_extract(data, '$.author') as author, count(*) as books from records group by 1 order by 2 desc, 1"], { env })).stdout);
    expect(rows).toEqual([
      { author: "Ana Lima", books: 2 },
      { author: "Ken Ito", books: 2 },
      { author: "Ruth Okafor", books: 1 },
    ]);
    const write = await cli(app, ["data", "sql", "delete from records"], { env });
    expect(write.code).toBe(2);
    expect(json(write.stderr).error).toMatch(/readonly|read-only/i);
    const two = await cli(app, ["data", "sql", "select 1; delete from records"], { env });
    expect(json(two.stderr).error).toBe("Run one statement at a time.");
    expect(json((await cli(app, ["data", "sql", "select count(*) as n from records"], { env })).stdout)).toEqual([{ n: 5 }]);
  });

  it("clear one list, or everything for the account", async () => {
    const env = libraryEnv();
    const app = createLibrary();
    await cli(app, ["data", "sync", "list-books"], { env });
    await cli(app, ["get-book", "b1"], { env });
    expect(json((await cli(app, ["data", "clear", "--cache"], { env })).stdout)).toEqual({ cached_results: 1, records: 0 });
    expect(json((await cli(app, ["data", "clear", "list-books"], { env })).stdout)).toEqual({ cached_results: 0, records: 5 });
    expect(json((await cli(app, ["data"], { env })).stdout).synced).toEqual([]);
  });

  it("explain mistakes in the data command itself", async () => {
    const env = libraryEnv();
    const app = createLibrary();
    expect(json((await cli(app, ["data", "shuffle"], { env })).stderr).error).toContain("It takes: status, sync, search, sql, clear");
    expect(json((await cli(app, ["data", "sync", "get-book"], { env })).stderr).error).toBe("get-book is not a list that can be synced.");
    expect(json((await cli(app, ["data", "search"], { env })).stderr).error).toContain("expects the words");
  });

  it("print search hits as lines for a person", async () => {
    const env = libraryEnv();
    const app = createLibrary();
    await cli(app, ["data", "sync", "list-books"], { env });
    const run = await cli(app, ["data", "search", "trains"], { env, isTTY: true });
    expect(run.stdout.startsWith("list-books  b5  ")).toBe(true);
    expect(run.stdout).toContain("[Trains]");
  });
});

describe("local data over MCP", () => {
  it("syncs in the background and searches offline", async () => {
    const env = libraryEnv();
    const mcp = await connect(createLibrary(), { env });
    const names = (await mcp.listTools()).map((tool) => tool.name);
    expect(names).toEqual(["list_books", "get_book", "rename_book", "local_search", "local_sync", "local_sync_status"]);

    const empty = await mcp.callTool("local_search", { query: "salt" });
    expect(empty.structuredContent).toMatchObject({ count: 0, hint: expect.stringContaining("local_sync") });

    const synced = await mcp.callTool("local_sync", { tool: "list_books", wait_seconds: 5 });
    expect(synced.structuredContent).toMatchObject({ done: true, result: { records: 5, complete: true } });

    const found = await mcp.callTool("local_search", { query: "salt stone", tool: "list_books" });
    await mcp.close();
    expect(found.structuredContent).toMatchObject({ count: 1, results: [{ tool: "list_books", id: "b4" }] });
  });

  it("are a toolset an operator can switch off, and absent from apps with nothing to sync", async () => {
    const off = await connect(createLibrary(), { env: libraryEnv({ LIBRARY_TOOLSETS: "none" }) });
    expect((await off.listTools()).map((tool) => tool.name)).toEqual(["list_books", "get_book", "rename_book"]);
    await off.close();
    const notes = await connect(createApp());
    expect((await notes.listTools()).some((tool) => tool.name.startsWith("local_"))).toBe(false);
    await notes.close();
  });
});

describe("search text", () => {
  it("indexes every string and number, and builds queries that cannot be syntax errors", () => {
    expect(searchText({ a: "x", b: [1, { c: "y" }], d: null, e: true })).toBe("x\n1\ny");
    expect(matchQuery('salt "stone OR')).toBe('"salt" """stone" "OR"*');
    expect(matchQuery("   ")).toBe("");
  });
});
