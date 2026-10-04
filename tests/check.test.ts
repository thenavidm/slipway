import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defineTool, jsonSchema, renderDocs, slipway, z } from "../src/index.js";
import { checkApp } from "../src/testing.js";
import { createApp } from "./fixtures/notes.js";
import { createLibrary, libraryEnv } from "./fixtures/library.js";
import { createRenderApp } from "./fixtures/renders.js";
import { fromOpenAPI } from "../src/index.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));

describe("slipway check", () => {
  it("passes a well-built app with no errors", async () => {
    const report = await checkApp(createApp(), { env: {} });
    expect(report.findings.filter((finding) => finding.level === "error")).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.stats).toMatchObject({ tools: 9, irreversible: 1, confirmed: 2, typedOutput: 1 });
  });

  it("finds generated tools identical on MCP and the CLI, on both protocol revisions", async () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "Mini", version: "1" },
      paths: {
        "/items/{id}": {
          get: { operationId: "getItem", summary: "Get an item", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "ok" } } },
          delete: { operationId: "deleteItem", summary: "Delete an item", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "204": { description: "gone" } } },
        },
      },
    };
    const generated = slipway({
      name: "mini",
      version: "1.0.0",
      package: "@example/mini",
      instructions: "Mini: get and delete items in the mini API.",
      context: () => ({}),
      tools: fromOpenAPI(spec, { execute: () => ({}) }),
    });
    for (const [app, env] of [
      [createRenderApp(), {}],
      [createLibrary(), libraryEnv()],
      [generated, {}],
    ] as const) {
      const report = await checkApp(app, { env });
      expect(report.findings.filter((finding) => finding.level === "error")).toEqual([]);
    }
  });

  it("fails a package that leaves npx to pick a binary by registry order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slipway-bins-"));
    const app = slipway({ name: "notes", version: "1.0.0", package: "@x/notes-mcp-cli", instructions: "Notes: read notes.", context: () => ({}), tools: [] });
    let n = 0;
    const errors = async (bin: Record<string, string>) => {
      const file = join(dir, `package-${++n}.json`);
      writeFileSync(file, JSON.stringify({ name: "@x/notes-mcp-cli", bin }));
      return (await checkApp(app, { env: {}, packageJson: file })).findings.filter((finding) => finding.check === "install" && finding.level === "error").map((finding) => finding.message);
    };
    // Either order fails while both share one file: the registry decides which comes first.
    expect((await errors({ "notes-mcp": "dist/index.js", "notes-cli": "dist/index.js" }))[0]).toContain("whichever one the registry lists first");
    expect((await errors({ "notes-cli": "dist/index.js", "notes-mcp": "dist/index.js" }))[0]).toContain('Add "notes-mcp-cli": "dist/npx.js" to bin');
    expect((await errors({ "notes-mcp": "dist/mcp.js", "notes-cli": "dist/cli.js" }))[0]).toContain("cannot choose");
    expect(await errors({ "notes-mcp": "dist/index.js", "notes-cli": "dist/index.js", "notes-mcp-cli": "dist/npx.js" })).toEqual([]);
  });

  it("catches thin descriptions, broken examples and a missing summary", async () => {
    const app = slipway({
      name: "bad",
      version: "0.0.1",
      context: () => ({}),
      tools: [
        defineTool({
          name: "get_thing",
          title: "Get",
          description: "Gets it.",
          input: z.object({ id: z.number().int() }),
          risk: "read",
          examples: [{ description: "wrong type", args: { id: "seven" } }],
          handler: () => ({}),
        }),
        defineTool({ name: "drop_all", title: "Drop everything", description: "Drop every record in the account, with no undo.", risk: "destructive", handler: () => ({}) }),
      ],
    });
    const report = await checkApp(app, { env: {} });
    const by = (check: string) => report.findings.filter((finding) => finding.check === check);
    expect(report.ok).toBe(false);
    expect(by("examples")[0]!.message).toContain("does not match the schema");
    expect(by("descriptions").some((finding) => finding.tool === "get_thing")).toBe(true);
    expect(by("safety")[0]!.tool).toBe("drop_all");
    expect(by("instructions")).toHaveLength(1);
  });

  it("flags schemas that are too large and definitions sent twice", async () => {
    const huge = { type: "object", properties: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`field_${i}`, { type: "string", description: "x".repeat(60) }])) };
    const block = { type: "object", properties: { a: { type: "string" } } };
    const app = slipway({
      name: "big",
      version: "0.0.1",
      instructions: "Big tests schema budgets.",
      context: () => ({}),
      tools: [
        defineTool({ name: "huge", title: "Huge", description: "A tool whose input schema is far too large to load cheaply.", input: jsonSchema(huge), risk: "read", handler: () => ({}) }),
        defineTool({
          name: "twice",
          title: "Twice",
          description: "A tool that carries the same definitions twice in its input schema.",
          input: jsonSchema({ type: "object", $defs: { Block: block }, properties: { payload: { type: "object", $defs: { Block: block } } } }),
          risk: "read",
          handler: () => ({}),
        }),
      ],
    });
    const report = await checkApp(app, { env: {}, schemaBudget: { warnBytes: 4_000, errorBytes: 20_000 } });
    expect(report.findings.find((finding) => finding.tool === "huge" && finding.check === "size")!.level).toBe("error");
    expect(report.findings.find((finding) => finding.tool === "twice" && finding.check === "size")!.message).toContain("Block");
  });

  it("checks that every command and flag the docs mention exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slipway-docs-"));
    const readme = join(dir, "README.md");
    writeFileSync(
      readme,
      [
        "Run `notes-cli get-note 1 --json` to read one. If notes-cli fails, STOP and run notes-cli doctor.",
        "The `notes-cli tools,` listing and `notes-cli list-notes.` in prose punctuation are fine.",
        "```bash",
        "notes-cli                       # every command, one line each",
        "notes-cli <command> --help",
        "notes-cli delete-notes 4",
        "notes-cli list-notes --bogus",
        "notes-cli doctor --network",
        "```",
      ].join("\n"),
    );
    const report = await checkApp(createApp(), { env: {}, docs: [readme] });
    const docs = report.findings.filter((finding) => finding.check === "docs").map((finding) => finding.message);
    expect(docs).toHaveLength(2);
    expect(docs[0]).toContain("'delete-notes', which is not a command");
    expect(docs[1]).toContain("--bogus");
  });

  it("starts the built server with nothing configured and times the answer", async () => {
    const report = await checkApp(createApp(), { env: {}, bin: join(fixtures, "notes-bin.mjs") });
    expect(report.findings.filter((finding) => finding.check === "startup")).toEqual([]);
    expect(report.stats.startupMs).toBeGreaterThan(0);
  }, 20_000);

  it("fails a server that exits when it is not configured", async () => {
    const report = await checkApp(createApp(), { env: {}, bin: join(fixtures, "exits-bin.mjs") });
    expect(report.findings.find((finding) => finding.check === "startup")!.message).toContain("exited with code 1");
  }, 20_000);
});

describe("slipway docs", () => {
  it("renders the command table and every argument from the tool list", () => {
    const docs = renderDocs(createApp(), {});
    expect(docs).toContain("| `delete-note` | Delete a note | Irreversible, needs confirm |");
    expect(docs).toContain("| `id` | integer | Yes | The note id. |");
    expect(docs).toContain("notes-cli get-note 1");
    expect(docs).toContain("`NOTES_READ_ONLY=1`");
  });
});
