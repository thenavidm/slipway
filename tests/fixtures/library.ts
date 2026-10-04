/**
 * A book catalog with a paged list worth keeping locally, a lookup worth
 * caching, and a write that makes cached answers stale.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slipway, toolkit, z } from "../../src/index.js";

export type Book = { id: string; title: string; author: string; blurb: string };
export type Catalog = { books: Book[]; calls: string[] };

export function createCatalog(): Catalog {
  return {
    books: [
      { id: "b1", title: "The Café on the Corner", author: "Ana Lima", blurb: "Coffee, rain and a long winter." },
      { id: "b2", title: "Mountain Roads", author: "Ken Ito", blurb: "A cycling trip across three passes." },
      { id: "b3", title: "Quiet Engines", author: "Ana Lima", blurb: "How electric motors changed the city." },
      { id: "b4", title: "Salt and Stone", author: "Ruth Okafor", blurb: "A coastal village keeps its traditions." },
      { id: "b5", title: "Night Trains", author: "Ken Ito", blurb: "Sleeper routes from Lisbon to Vienna." },
    ],
    calls: [],
  };
}

type Ctx = { catalog: Catalog; key: string | undefined };
const { defineTool } = toolkit<Ctx>();

const listBooks = defineTool({
  name: "list_books",
  title: "List books",
  description: "List books in the catalog, two at a time, optionally by one author.",
  input: z.object({
    author: z.string().optional().describe("Only books by this author."),
    cursor: z.string().optional().describe("Continue from a previous page."),
    limit: z.number().int().min(1).max(2).optional().describe("Books per page, 1-2."),
  }),
  risk: "read",
  paginate: { cursorArg: "cursor", nextCursor: "next", items: "books", limitArg: "limit", maxLimit: 2 },
  sync: { id: "id" },
  handler: ({ author, cursor, limit }, ctx) => {
    ctx.catalog.calls.push(`list ${cursor ?? 0}`);
    const all = ctx.catalog.books.filter((book) => !author || book.author === author);
    const start = Number(cursor ?? 0);
    const size = limit ?? 2;
    const next = start + size < all.length ? String(start + size) : undefined;
    return { books: all.slice(start, start + size), ...(next ? { next } : {}) };
  },
});

const getBook = defineTool({
  name: "get_book",
  title: "Get a book",
  description: "Read one book by its id, with its blurb.",
  input: z.object({ id: z.string().describe("The book id.") }),
  risk: "read",
  positional: ["id"],
  cache: { ttlSeconds: 60 },
  handler: ({ id }, ctx) => {
    ctx.catalog.calls.push(`get ${id}`);
    const book = ctx.catalog.books.find((candidate) => candidate.id === id);
    if (!book) throw Object.assign(new Error(`No book ${id}.`), { status: 404 });
    return { ...book, served_with: `key=${ctx.key}` };
  },
});

const renameBook = defineTool({
  name: "rename_book",
  title: "Rename a book",
  description: "Change a book's title in the catalog.",
  input: z.object({ id: z.string().describe("The book id."), title: z.string().min(1).describe("The new title.") }),
  risk: "write",
  handler: ({ id, title }, ctx) => {
    const book = ctx.catalog.books.find((candidate) => candidate.id === id);
    if (!book) throw Object.assign(new Error(`No book ${id}.`), { status: 404 });
    book.title = title;
    return book;
  },
});

export function createLibrary(catalog: Catalog = createCatalog()) {
  return slipway<Ctx>({
    name: "library",
    title: "Library",
    version: "1.0.0",
    instructions: "Library: list, read and rename books in the catalog, and search a local copy offline.",
    context: (env) => ({ catalog, key: env.LIBRARY_API_KEY }),
    secrets: (ctx) => [ctx.key],
    tools: [listBooks, getBook, renameBook],
  });
}

/** An environment with its own empty data folder. */
export function libraryEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { LIBRARY_DATA_DIR: join(mkdtempSync(join(tmpdir(), "slipway-data-")), "library"), LIBRARY_API_KEY: "lib-key-123456", ...extra };
}
