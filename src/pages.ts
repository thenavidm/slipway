/**
 * Following a list to its end.
 *
 * A cursor-paginated tool says where its cursor and its items are, so the CLI's
 * `--all` and `data sync` can walk every page the same way, instead of each
 * leaving the loop to a script or a model.
 */

import type { App, InvokeOptions } from "./app.js";
import { EXIT, SlipwayError } from "./errors.js";
import { isContentResult } from "./result.js";
import type { Tool } from "./tool.js";

export function getPath(data: unknown, path: string): unknown {
  let current = data;
  for (const part of path.split(".").filter(Boolean)) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export type PagesRun = { count: number; pages: number; next_cursor: unknown; complete: boolean };

/** A hard ceiling, so an API that keeps returning a new cursor forever cannot spin forever. */
const MAX_PAGES = 10_000;

/**
 * Call a tool page after page, handing each page's items to `onPage`, until the
 * pages run out or `max` items arrived. A tool that does not page is called
 * once. `complete` is true when the list ended, not the item limit.
 */
export async function eachPage(
  app: App,
  tool: Tool,
  args: Record<string, unknown>,
  options: InvokeOptions,
  itemsPath: string,
  max: number,
  onPage: (items: unknown[]) => void | Promise<void>,
): Promise<PagesRun> {
  const paginate = tool.paginate;
  let count = 0;
  let pages = 0;
  let cursor = paginate ? args[paginate.cursorArg] : undefined;
  for (;;) {
    const pageArgs: Record<string, unknown> = { ...args };
    if (paginate) {
      if (cursor !== undefined && cursor !== null && cursor !== "") pageArgs[paginate.cursorArg] = cursor;
      else delete pageArgs[paginate.cursorArg];
      if (paginate.limitArg && paginate.maxLimit && pageArgs[paginate.limitArg] === undefined) {
        pageArgs[paginate.limitArg] = Math.max(1, Math.min(paginate.maxLimit, max - count));
      }
    }
    const value = await app.invoke(tool.name, pageArgs, options);
    const data = isContentResult(value) ? value.data : value;
    const page = getPath(data, itemsPath);
    if (!Array.isArray(page)) throw new SlipwayError(`${tool.name} returned no list at '${itemsPath}'.`, "internal", EXIT.error);
    const kept = page.slice(0, Math.max(0, max - count));
    await onPage(kept);
    count += kept.length;
    pages++;
    if (!paginate) return { count, pages, next_cursor: null, complete: kept.length === page.length };
    const next = getPath(data, paginate.nextCursor);
    const ended = next === undefined || next === null || next === "" || next === cursor;
    if (ended) return { count, pages, next_cursor: null, complete: true };
    cursor = next;
    if (count >= max || pages >= MAX_PAGES) return { count, pages, next_cursor: cursor ?? null, complete: false };
  }
}
