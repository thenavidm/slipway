/**
 * Local data: a response cache, synced copies of lists, and search over them.
 *
 * An agent that asks the same question twice should not pay the service twice,
 * and a person who wants to search ten thousand records should not page
 * through an API to do it. So each app keeps one SQLite file on this machine,
 * readable only by its owner, holding:
 *
 * - cached results of read tools that opted in, per account, cleared by any
 *   write through the same app;
 * - records synced from list tools, searchable offline with full-text search
 *   and queryable with read-only SQL.
 *
 * It uses `node:sqlite`, which ships with Node.js 22.13 and later, so there is
 * nothing to install. Where it is missing, the cache quietly stays off and the
 * data commands say what to upgrade. Nothing here ever fails a tool call: a
 * cache that cannot be read is a cache miss.
 */

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SlipwayError, UsageError, EXIT } from "./errors.js";
import { sha256, stableJson } from "./util.js";

type Sqlite = typeof import("node:sqlite");
type Database = InstanceType<Sqlite["DatabaseSync"]>;

let loading: Promise<Sqlite | undefined> | undefined;

/**
 * Load `node:sqlite` once. Node prints an experimental-feature warning when it
 * loads, which would land in every CLI command's output, so only that one
 * warning is held back while it loads.
 */
export function loadSqlite(): Promise<Sqlite | undefined> {
  loading ??= (async () => {
    const original = process.emitWarning;
    process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
      const text = typeof warning === "string" ? warning : warning?.message ?? "";
      if (/sqlite/i.test(text)) return;
      return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
    } as typeof process.emitWarning;
    try {
      return (await import("node:sqlite")) as Sqlite;
    } catch {
      return undefined;
    } finally {
      process.emitWarning = original;
    }
  })();
  return loading;
}

export class NoSqliteError extends SlipwayError {
  constructor() {
    super(`Local data needs Node.js 22.13 or later, which includes SQLite. This is Node.js ${process.versions.node}.`, "not_configured", EXIT.notConfigured, {
      hint: "Install a current Node.js LTS release, then run the command again.",
    });
  }
}

/** Where each operating system keeps an app's own data. */
export function dataRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  if (platform === "darwin") return join(home, "Library", "Application Support");
  if (platform === "win32") return env.LOCALAPPDATA || join(home, "AppData", "Local");
  return env.XDG_DATA_HOME || join(home, ".local", "share");
}

/** The folder for one app's data: `<PREFIX>_DATA_DIR`, or `slipway/<name>` in the system's data folder. */
export function dataDir(appName: string, envPrefix: string, env: NodeJS.ProcessEnv): string {
  return env[`${envPrefix}_DATA_DIR`]?.trim() || join(dataRoot(env), "slipway", appName);
}

const SCHEMA_VERSION = 1;
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS cache (
    scope TEXT NOT NULL, tool TEXT NOT NULL, key TEXT NOT NULL,
    value TEXT NOT NULL, stored_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    PRIMARY KEY (scope, tool, key)
  );
  CREATE INDEX IF NOT EXISTS cache_expires ON cache (expires_at);
  CREATE TABLE IF NOT EXISTS records (
    scope TEXT NOT NULL, tool TEXT NOT NULL, id TEXT NOT NULL,
    data TEXT NOT NULL, synced_at INTEGER NOT NULL,
    PRIMARY KEY (scope, tool, id)
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5 (
    text, scope UNINDEXED, tool UNINDEXED, id UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TABLE IF NOT EXISTS syncs (
    scope TEXT NOT NULL, tool TEXT NOT NULL, filters TEXT NOT NULL,
    started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL,
    records INTEGER NOT NULL, pages INTEGER NOT NULL, complete INTEGER NOT NULL,
    PRIMARY KEY (scope, tool, filters)
  );
`;

/** The longest cached result kept. Anything bigger costs more to store than to fetch again. */
const MAX_CACHED_BYTES = 1024 * 1024;
/** The most text from one record that search indexes. */
const MAX_INDEXED_CHARS = 64 * 1024;

export type SearchHit = { tool: string; id: string; snippet: string; record: unknown };

export type SyncedTool = { tool: string; records: number; last_sync?: string; complete?: boolean };

/** One app's local data file. */
export class DataStore {
  private constructor(
    readonly file: string,
    private readonly db: Database,
    private readonly sqlite: Sqlite,
  ) {}

  /** Open the file, creating its folder and the file itself readable by their owner only. */
  static async open(dir: string): Promise<DataStore> {
    const sqlite = await loadSqlite();
    if (!sqlite) throw new NoSqliteError();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "data.db");
    // SQLite gives its journal files the database file's own permissions, so
    // creating the file private first keeps all three private.
    if (!existsSync(file)) closeSync(openSync(file, "a", 0o600));
    if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
    const db = new sqlite.DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
    db.exec(SCHEMA);
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
    return new DataStore(file, db, sqlite);
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  cacheGet(scope: string, tool: string, key: string, now = Date.now()): { value: unknown; storedAt: number } | undefined {
    const row = this.db.prepare("SELECT value, stored_at FROM cache WHERE scope = ? AND tool = ? AND key = ? AND expires_at > ?").get(scope, tool, key, now) as
      | { value: string; stored_at: number }
      | undefined;
    return row ? { value: JSON.parse(row.value), storedAt: Number(row.stored_at) } : undefined;
  }

  cachePut(scope: string, tool: string, key: string, value: unknown, ttlSeconds: number, now = Date.now()): void {
    const text = JSON.stringify(value);
    if (text === undefined || text.length > MAX_CACHED_BYTES) return;
    this.db.prepare("DELETE FROM cache WHERE expires_at <= ?").run(now);
    this.db
      .prepare("INSERT OR REPLACE INTO cache (scope, tool, key, value, stored_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(scope, tool, key, text, now, now + Math.round(ttlSeconds * 1000));
  }

  /** Forget every cached result for one account, after anything changed it. */
  cacheClear(scope?: string): number {
    const result = scope === undefined ? this.db.prepare("DELETE FROM cache").run() : this.db.prepare("DELETE FROM cache WHERE scope = ?").run(scope);
    return Number(result.changes);
  }

  /** Store a page of records. Each is replaced whole, and indexed for search. */
  putRecords(scope: string, tool: string, records: Array<{ id: string; data: unknown }>, syncedAt: number): void {
    const upsert = this.db.prepare("INSERT OR REPLACE INTO records (scope, tool, id, data, synced_at) VALUES (?, ?, ?, ?, ?)");
    const unindex = this.db.prepare("DELETE FROM records_fts WHERE scope = ? AND tool = ? AND id = ?");
    const index = this.db.prepare("INSERT INTO records_fts (text, scope, tool, id) VALUES (?, ?, ?, ?)");
    this.transaction(() => {
      for (const record of records) {
        upsert.run(scope, tool, record.id, JSON.stringify(record.data) ?? "null", syncedAt);
        unindex.run(scope, tool, record.id);
        index.run(searchText(record.data), scope, tool, record.id);
      }
    });
  }

  /** After a complete sync, drop the records the service no longer lists. */
  removeUnseen(scope: string, tool: string, syncedBefore: number): number {
    return this.transaction(() => {
      const gone = this.db.prepare("SELECT id FROM records WHERE scope = ? AND tool = ? AND synced_at < ?").all(scope, tool, syncedBefore) as Array<{ id: string }>;
      const unindex = this.db.prepare("DELETE FROM records_fts WHERE scope = ? AND tool = ? AND id = ?");
      for (const row of gone) unindex.run(scope, tool, row.id);
      this.db.prepare("DELETE FROM records WHERE scope = ? AND tool = ? AND synced_at < ?").run(scope, tool, syncedBefore);
      return gone.length;
    });
  }

  recordSync(scope: string, tool: string, filters: string, run: { startedAt: number; records: number; pages: number; complete: boolean }): void {
    this.db
      .prepare("INSERT OR REPLACE INTO syncs (scope, tool, filters, started_at, finished_at, records, pages, complete) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(scope, tool, filters, run.startedAt, Date.now(), run.records, run.pages, run.complete ? 1 : 0);
  }

  search(scope: string, words: string, options: { tool?: string; limit?: number } = {}): SearchHit[] {
    const query = matchQuery(words);
    if (!query) return [];
    const limit = Math.max(1, Math.min(100, options.limit ?? 20));
    const rows = this.db
      .prepare(
        `SELECT f.tool AS tool, f.id AS id, snippet(records_fts, 0, '[', ']', '…', 12) AS snippet, r.data AS data
         FROM records_fts f JOIN records r ON r.scope = f.scope AND r.tool = f.tool AND r.id = f.id
         WHERE records_fts MATCH ? AND f.scope = ? ${options.tool ? "AND f.tool = ?" : ""}
         ORDER BY rank LIMIT ?`,
      )
      .all(...([query, scope, ...(options.tool ? [options.tool] : []), limit] as [string, ...Array<string | number>])) as Array<{ tool: string; id: string; snippet: string; data: string }>;
    return rows.map((row) => ({ tool: row.tool, id: row.id, snippet: row.snippet, record: JSON.parse(row.data) }));
  }

  synced(scope: string): SyncedTool[] {
    const counts = this.db.prepare("SELECT tool, COUNT(*) AS n FROM records WHERE scope = ? GROUP BY tool ORDER BY tool").all(scope) as Array<{ tool: string; n: number }>;
    const last = this.db.prepare("SELECT tool, MAX(finished_at) AS at, MAX(complete) AS complete FROM syncs WHERE scope = ? GROUP BY tool").all(scope) as Array<{
      tool: string;
      at: number;
      complete: number;
    }>;
    const tools = new Set([...counts.map((row) => row.tool), ...last.map((row) => row.tool)]);
    return [...tools].sort().map((tool) => {
      const count = counts.find((row) => row.tool === tool);
      const sync = last.find((row) => row.tool === tool);
      return {
        tool,
        records: Number(count?.n ?? 0),
        ...(sync ? { last_sync: new Date(Number(sync.at)).toISOString(), complete: Boolean(sync.complete) } : {}),
      };
    });
  }

  cacheEntries(scope: string, now = Date.now()): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM cache WHERE scope = ? AND expires_at > ?").get(scope, now) as { n: number }).n);
  }

  /** Delete one account's synced records, for one tool or all of them. */
  clearRecords(scope: string, tool?: string): number {
    return this.transaction(() => {
      const where = tool ? "scope = ? AND tool = ?" : "scope = ?";
      const params = tool ? [scope, tool] : [scope];
      const removed = Number(this.db.prepare(`DELETE FROM records WHERE ${where}`).run(...params).changes);
      this.db.prepare(`DELETE FROM records_fts WHERE ${where}`).run(...params);
      this.db.prepare(`DELETE FROM syncs WHERE ${where}`).run(...params);
      return removed;
    });
  }

  /**
   * Run one read-only statement on its own connection, which SQLite itself
   * refuses to write through, whatever the statement says.
   */
  query(sql: string): Array<Record<string, unknown>> {
    const reader = new this.sqlite.DatabaseSync(this.file, { readOnly: true });
    try {
      reader.exec("PRAGMA query_only = 1");
      let statement;
      try {
        statement = reader.prepare(sql);
      } catch (error) {
        throw new UsageError(`SQL error: ${(error as Error).message}`, { hint: "Tables: records (scope, tool, id, data, synced_at), cache, syncs. data is JSON: json_extract(data, '$.title')." });
      }
      const wanted = sql.trim().replace(/;\s*$/, "").length;
      const compiled = statement.sourceSQL.trim().replace(/;\s*$/, "").length;
      if (compiled < wanted) throw new UsageError("Run one statement at a time.");
      try {
        return (statement.all() as Array<Record<string, unknown>>).map((row) => ({ ...row }));
      } catch (error) {
        throw new UsageError(`SQL error: ${(error as Error).message}`);
      }
    } finally {
      reader.close();
    }
  }
}

const stores = new Map<string, Promise<DataStore>>();

/** The open store for a folder, shared by every call in this process. */
export function storeAt(dir: string): Promise<DataStore> {
  let store = stores.get(dir);
  if (!store) {
    store = DataStore.open(dir);
    store.catch(() => stores.delete(dir));
    stores.set(dir, store);
  }
  return store;
}

/** Close every open store. For tests and for a server shutting down. */
export async function closeStores(): Promise<void> {
  const open = [...stores.values()];
  stores.clear();
  for (const store of open) (await store.catch(() => undefined))?.close();
}

/**
 * Which account data belongs to. Cached results and synced records are only
 * ever read back for the account they came from, so switching keys never shows
 * one account another's data.
 */
export function scopeOf(credentials: ReadonlyArray<string | undefined | null>, explicit?: string): string {
  if (explicit) return `id:${sha256(explicit).slice(0, 16)}`;
  const values = credentials.filter((value): value is string => typeof value === "string" && value.length > 0).sort();
  return values.length ? `key:${sha256(values.join("\0")).slice(0, 16)}` : "default";
}

/** The cache key for one call: the tool's own arguments, in a stable order. */
export function cacheKey(args: Record<string, unknown>): string {
  return sha256(stableJson(args));
}

/** Every string and number in a record, which is what full-text search reads. */
export function searchText(value: unknown): string {
  const parts: string[] = [];
  let size = 0;
  const visit = (node: unknown): void => {
    if (size > MAX_INDEXED_CHARS) return;
    if (typeof node === "string") {
      parts.push(node);
      size += node.length;
    } else if (typeof node === "number" && Number.isFinite(node)) parts.push(String(node));
    else if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === "object") Object.values(node).forEach(visit);
  };
  visit(value);
  return parts.join("\n").slice(0, MAX_INDEXED_CHARS);
}

/**
 * Words a person typed, as an FTS5 query that cannot be a syntax error: every
 * word must appear, the last may be the start of a word.
 */
export function matchQuery(words: string): string {
  const terms = words.split(/\s+/).map((term) => term.trim()).filter(Boolean);
  return terms.map((term, i) => `"${term.replace(/"/g, '""')}"${i === terms.length - 1 ? "*" : ""}`).join(" ");
}
