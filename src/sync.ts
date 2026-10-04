/**
 * Copying lists to this machine, and the MCP tools that search and refresh them.
 *
 * `data sync <command>` in a terminal and `local_sync` over MCP do the same
 * thing: follow every page of a list tool and keep each item, keyed by its id,
 * in the local data file. A sync with no filters mirrors the list, so records
 * the service no longer lists are removed. A filtered sync only adds and
 * updates, because what it did not see may still exist outside the filter.
 */

import * as z from "zod";
import type { App, InvokeOptions } from "./app.js";
import { UsageError } from "./errors.js";
import { eachPage, getPath } from "./pages.js";
import { defineTool, type Tool } from "./tool.js";
import { stableJson } from "./util.js";

export type SyncReport = {
  tool: string;
  command: string;
  /** Records kept from this run. */
  records: number;
  /** Items with no id at the sync's id path, which could not be kept. */
  skipped: number;
  /** Records removed because a complete, unfiltered sync no longer saw them. */
  removed: number;
  pages: number;
  /** The list ended, rather than the run stopping early. */
  complete: boolean;
  /** Filters were given, so nothing was removed. */
  filtered: boolean;
  seconds: number;
};

/** A sync's filters: its arguments without the cursor and page size, which only say which page. */
function filtersOf(tool: Tool, args: Record<string, unknown>): Record<string, unknown> {
  const { [tool.paginate?.cursorArg ?? "\0"]: _cursor, [tool.paginate?.limitArg ?? "\0"]: _limit, ...filters } = args;
  return filters;
}

export async function syncTool(app: App, tool: Tool, args: Record<string, unknown>, options: InvokeOptions & { env: NodeJS.ProcessEnv }): Promise<SyncReport> {
  if (!tool.sync) {
    throw new UsageError(`${tool.command} is not a list that can be synced.`, { hint: `Synced lists: ${app.allTools.filter((candidate) => candidate.sync).map((candidate) => candidate.command).join(", ") || "none"}.` });
  }
  const sync = tool.sync;
  const store = await app.localData(options.env);
  const scope = app.dataScope(await app.context(options.env));
  const filters = filtersOf(tool, args);
  const startedAt = Date.now();
  let skipped = 0;
  let kept = 0;

  // A copy made from cached pages would be as old as the cache, so a sync always asks the service.
  const run = await eachPage(app, tool, args, { ...options, refresh: true }, sync.items, Number.POSITIVE_INFINITY, async (items) => {
    const records: Array<{ id: string; data: unknown }> = [];
    for (const item of items) {
      const id = getPath(item, sync.id);
      if ((typeof id !== "string" || !id) && typeof id !== "number") {
        skipped++;
        continue;
      }
      // Records are kept as clients would see them, with credentials masked.
      records.push({ id: String(id), data: app.secrets.redactDeep(item) });
    }
    store.putRecords(scope, tool.name, records, startedAt);
    kept += records.length;
    await options.onProgress?.({ progress: kept, message: `${kept} records` });
  });

  const filtered = Object.keys(filters).length > 0;
  const removed = run.complete && !filtered ? store.removeUnseen(scope, tool.name, startedAt) : 0;
  store.recordSync(scope, tool.name, stableJson(filters), { startedAt, records: kept, pages: run.pages, complete: run.complete });
  return {
    tool: tool.name,
    command: tool.command,
    records: kept,
    skipped,
    removed,
    pages: run.pages,
    complete: run.complete,
    filtered,
    seconds: Math.round((Date.now() - startedAt) / 100) / 10,
  };
}

/**
 * `local_search` and `local_sync`, for an app with at least one synced list.
 * They are in the `local` toolset, so an operator can switch them off.
 */
export function localDataTools<Ctx>(synced: readonly Tool<Ctx>[], getApp: () => App<Ctx>): Tool<Ctx>[] {
  const names = synced.map((tool) => tool.name) as [string, ...string[]];
  const listed = names.join(", ");

  const searchInput = z.object({
    query: z.string().min(1).describe("The words to find. Every word must appear; the last may be the start of a word."),
    tool: z.enum(names).optional().describe("Only records synced from this tool."),
    limit: z.number().int().min(1).max(50).optional().describe("How many results, 1-50. Defaults to 10."),
  });
  const search = defineTool<Ctx, typeof searchInput>({
    name: "local_search",
    title: "Search synced data",
    description: `Search the records synced to this machine from ${listed}. Fast, offline, and costs no API calls. If nothing is found, or the data may be old, run local_sync first.`,
    input: searchInput,
    risk: "read",
    openWorld: false,
    tags: ["local"],
    handler: async ({ query, tool, limit }, ctx) => {
      const app = getApp();
      const store = await app.localData(ctx.env);
      const hits = store.search(app.dataScope(ctx), query, { ...(tool ? { tool } : {}), limit: limit ?? 10 });
      return {
        query,
        count: hits.length,
        results: hits,
        ...(hits.length ? {} : { hint: `Nothing synced matches. Sync with local_sync first, from one of: ${listed}.` }),
      };
    },
  });

  const syncInput = z.object({
    tool: z.enum(names).describe("The list tool to copy."),
    arguments: z.record(z.string(), z.unknown()).optional().describe("Filters for that tool, as its own arguments. With none, records the service no longer lists are removed."),
  });
  const syncData = defineTool<Ctx, typeof syncInput>({
    name: "local_sync",
    title: "Sync data locally",
    description: `Copy every record one of ${listed} lists to this machine, page by page, so local_search can find them offline. Runs in the background, since a long list takes a while.`,
    input: syncInput,
    risk: "read",
    idempotent: true,
    tags: ["local"],
    job: { background: true },
    handler: async ({ tool, arguments: args }, ctx) => {
      const app = getApp();
      const target = app.find(tool)!;
      return syncTool(app, target, await app.parse(target, args ?? {}), {
        surface: ctx.surface,
        signal: ctx.signal,
        env: ctx.env,
        onProgress: ({ progress, total, message }) => ctx.progress(progress, total, message),
      });
    },
  });

  return [search, syncData];
}
