/**
 * A small notes service with one tool of every kind Slipway handles: reads,
 * writes, an irreversible delete, a tool generated from a JSON contract,
 * pagination, a paid export in its own toolset, a secret that must never leak,
 * a slow call, and an image result.
 */

import { AuthError, content, httpError, image, jsonSchema, slipway, toolkit, z } from "../../src/index.js";

export type Note = { id: number; title: string; body: string };
export type Store = { notes: Note[]; calls: string[] };

export function createStore(count = 7): Store {
  return {
    notes: Array.from({ length: count }, (_, i) => ({ id: i + 1, title: `Note ${i + 1}`, body: `Body ${i + 1}` })),
    calls: [],
  };
}

type Ctx = { store: Store; key: string | undefined };
const { defineTool } = toolkit<Ctx>();

const NoteSchema = z.object({ id: z.number().int(), title: z.string(), body: z.string() });

const listNotes = defineTool({
  name: "list_notes",
  title: "List notes",
  description: "List notes, oldest first, a page at a time. Pass the cursor from the last page to continue.",
  input: z.object({
    cursor: z.string().optional().describe("Continue from a previous page."),
    limit: z.number().int().min(1).max(3).optional().describe("Notes per page, 1-3."),
  }),
  risk: "read",
  paginate: { cursorArg: "cursor", nextCursor: "cursor", items: "notes", limitArg: "limit", maxLimit: 3 },
  handler: ({ cursor, limit }, ctx) => {
    const start = cursor ? Number(cursor) : 0;
    const size = limit ?? 3;
    const notes = ctx.store.notes.slice(start, start + size);
    const next = start + size < ctx.store.notes.length ? String(start + size) : undefined;
    return { notes, ...(next ? { cursor: next } : {}) };
  },
});

const getNote = defineTool({
  name: "get_note",
  title: "Get a note",
  description: "Read one note by its id, with its full body text.",
  input: z.object({ id: z.number().int().min(1).describe("The note id.") }),
  output: NoteSchema,
  risk: "read",
  positional: ["id"],
  examples: [{ description: "Read note 1", args: { id: 1 } }],
  handler: ({ id }, ctx) => {
    const note = ctx.store.notes.find((candidate) => candidate.id === id);
    if (!note) throw httpError(404, `No note ${id}.`);
    return note;
  },
});

const createNote = defineTool({
  name: "create_note",
  title: "Create a note",
  description: "Create a new note with a title and body text. Returns the new note.",
  input: z.object({
    title: z.string().min(1).describe("The title."),
    body: z.string().default("").describe("The body text."),
    tags: z.array(z.string()).optional().describe("Labels for the note."),
  }),
  risk: "write",
  summary: ({ title }) => `create '${title}'`,
  handler: ({ title, body }, ctx) => {
    const note = { id: ctx.store.notes.length + 1, title, body };
    ctx.store.notes.push(note);
    ctx.store.calls.push("create_note");
    return note;
  },
});

const deleteNote = defineTool({
  name: "delete_note",
  title: "Delete a note",
  description: "Delete a note forever. There is no undo and no trash.",
  input: z.object({ id: z.number().int().min(1).describe("The note id.") }),
  risk: "destructive",
  positional: ["id"],
  summary: ({ id }) => `delete note ${id}`,
  handler: ({ id }, ctx) => {
    ctx.store.calls.push(`delete_note ${id}`);
    ctx.store.notes = ctx.store.notes.filter((note) => note.id !== id);
    return { deleted: id };
  },
});

const renameNote = defineTool({
  name: "rename_note",
  title: "Rename a note",
  description: "Change a note's title. Generated from the notes API contract.",
  input: jsonSchema<{ id: number; title: string }>({
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1, description: "The note id." },
      title: { type: "string", minLength: 1, description: "The new title." },
    },
    required: ["id", "title"],
    additionalProperties: false,
  }),
  risk: "write",
  handler: ({ id, title }, ctx) => {
    const note = ctx.store.notes.find((candidate) => candidate.id === id);
    if (!note) throw httpError(404, `No note ${id}.`);
    note.title = title;
    return note;
  },
});

const exportAll = defineTool({
  name: "export_all",
  title: "Export every note",
  description: "Export every note as one JSON document. Counts against the monthly export quota.",
  risk: "read",
  requireConfirm: true,
  tags: ["admin"],
  summary: () => "export every note",
  handler: (_args, ctx) => ({ count: ctx.store.notes.length, notes: ctx.store.notes }),
});

const whoami = defineTool({
  name: "whoami",
  title: "Show the account",
  description: "Show which account the API key belongs to, without revealing the key.",
  risk: "read",
  openWorld: false,
  handler: (_args, ctx) => {
    if (!ctx.key) throw new AuthError("No API key was sent.");
    return { account: "demo", echoed: `key=${ctx.key}` };
  },
});

const slowReport = defineTool({
  name: "slow_report",
  title: "Build a slow report",
  description: "Build a report that takes a long time, for testing timeouts.",
  risk: "read",
  timeoutMs: 50,
  handler: () => new Promise((resolve) => setTimeout(() => resolve({ done: true }), 2_000)),
});

const chart = defineTool({
  name: "chart",
  title: "Render a chart",
  description: "Render the number of notes as a tiny PNG chart image.",
  risk: "read",
  handler: () => content([image(new Uint8Array([137, 80, 78, 71]), "image/png")], { width: 1, height: 1 }),
});

export const tools = [listNotes, getNote, createNote, deleteNote, renameNote, exportAll, whoami, slowReport, chart];

export function createApp(store: Store = createStore()) {
  return slipway<Ctx>({
    name: "notes",
    title: "Notes",
    version: "1.0.0",
    description: "a demo notes service",
    instructions:
      "Notes: read, create, rename and delete notes in the demo notes service. Deleting is permanent, so delete_note runs only with confirm: true.",
    context: (env) => ({ store, key: env.NOTES_API_KEY }),
    configured: (ctx) => Boolean(ctx.key),
    secrets: (ctx) => [ctx.key],
    tools,
    toolsets: { admin: "Exports and account-wide operations" },
    resources: [{ name: "about", uri: "notes://about", title: "About notes", mimeType: "text/markdown", read: () => "Notes are short texts." }],
    prompts: [{ name: "summarize", title: "Summarize notes", description: "Summarize every note.", render: () => "Summarize my notes." }],
    login: "Set NOTES_API_KEY to a key from the demo dashboard.",
  });
}
