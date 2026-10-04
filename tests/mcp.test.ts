import { describe, expect, it } from "vitest";
import { connect, resultData } from "../src/testing.js";
import { createApp, createStore } from "./fixtures/notes.js";

function payload(result: { content?: Array<{ type: string; text?: string }> }) {
  return JSON.parse(result.content?.[0]?.text ?? "null");
}

describe("MCP surface", () => {
  it("lists every tool with annotations that match its risk", async () => {
    const mcp = await connect(createApp());
    const tools = await mcp.listTools();
    await mcp.close();

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      ["chart", "create_note", "delete_note", "export_all", "get_note", "list_notes", "rename_note", "slow_report", "whoami"],
    );
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    expect(byName.list_notes!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    expect(byName.delete_note!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    expect(byName.whoami!.annotations).toMatchObject({ openWorldHint: false });
    expect(byName.get_note!.title).toBe("Get a note");
  });

  it("adds confirm only where it is required, and asks the client to put a person in front of it", async () => {
    const mcp = await connect(createApp());
    const byName = Object.fromEntries((await mcp.listTools()).map((tool) => [tool.name, tool]));
    await mcp.close();

    const props = (name: string) => Object.keys((byName[name]!.inputSchema.properties as object) ?? {});
    expect(props("delete_note")).toContain("confirm");
    expect(props("export_all")).toContain("confirm");
    expect(props("get_note")).not.toContain("confirm");
    expect(byName.delete_note!._meta?.["anthropic/requiresUserInteraction"]).toBe(true);
    expect(byName.get_note!._meta).toBeUndefined();
  });

  it("stops asking for a person when the operator lets the model confirm", async () => {
    const mcp = await connect(createApp(), { env: { NOTES_CONFIRM: "model" } });
    const tool = (await mcp.listTools()).find((candidate) => candidate.name === "delete_note")!;
    await mcp.close();
    expect(tool._meta).toBeUndefined();
  });

  it("returns typed results as structured content, with compact text beside them", async () => {
    const mcp = await connect(createApp());
    const tools = await mcp.listTools();
    expect(tools.find((tool) => tool.name === "get_note")!.outputSchema).toMatchObject({ type: "object" });

    const result = await mcp.callTool("get_note", { id: 1 });
    await mcp.close();
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ id: 1, title: "Note 1", body: "Body 1" });
    expect(result.content[0]).toEqual({ type: "text", text: '{"id":1,"title":"Note 1","body":"Body 1"}' });
  });

  it("sends an untyped result as text alone, because Codex reads a structured copy in place of the text", async () => {
    const mcp = await connect(createApp());
    const result = await mcp.callTool("list_notes", {});
    await mcp.close();
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(resultData(result)).toMatchObject({ notes: expect.any(Array) });
  });

  it("refuses an irreversible call without confirm, and runs it with confirm", async () => {
    const store = createStore();
    const mcp = await connect(createApp(store));

    const refused = await mcp.callTool("delete_note", { id: 1 });
    expect(refused.isError).toBe(true);
    expect(payload(refused)).toMatchObject({ code: "refused" });
    expect(payload(refused).error).toContain("confirm: true");
    expect(payload(refused).error).toContain("delete note 1");
    expect(store.calls).toEqual([]);

    const done = await mcp.callTool("delete_note", { id: 1, confirm: true });
    await mcp.close();
    expect(done.isError).toBeFalsy();
    expect(resultData(done)).toEqual({ deleted: 1 });
    expect(store.notes.some((note) => note.id === 1)).toBe(false);
  });

  it("validates a contract tool against its JSON Schema before the handler runs", async () => {
    const mcp = await connect(createApp());
    const bad = await mcp.callTool("rename_note", { id: 0, title: "x" });
    const extra = await mcp.callTool("rename_note", { id: 1, title: "x", color: "red" });
    const good = await mcp.callTool("rename_note", { id: 1, title: "Renamed" });
    await mcp.close();
    expect(bad.isError).toBe(true);
    expect(extra.isError).toBe(true);
    expect(resultData(good)).toMatchObject({ id: 1, title: "Renamed" });
  });

  it("reports upstream failures with a code a model can act on", async () => {
    const mcp = await connect(createApp());
    const missing = await mcp.callTool("get_note", { id: 99 });
    const auth = await mcp.callTool("whoami", {});
    await mcp.close();
    expect(payload(missing)).toMatchObject({ code: "not_found", status: 404 });
    expect(payload(auth)).toMatchObject({ code: "auth" });
  });

  it("never lets a registered secret reach the client", async () => {
    const mcp = await connect(createApp(), { env: { NOTES_API_KEY: "sk-live-1234567890" } });
    const result = await mcp.callTool("whoami", {});
    await mcp.close();
    expect(JSON.stringify(result)).not.toContain("sk-live-1234567890");
    expect(resultData(result)).toMatchObject({ echoed: "key=[redacted]" });
  });

  it("times a slow tool out instead of leaving the client waiting", async () => {
    const mcp = await connect(createApp());
    const started = Date.now();
    const result = await mcp.callTool("slow_report", {});
    await mcp.close();
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(payload(result)).toMatchObject({ code: "timeout" });
  });

  it("passes content results through, and keeps their data for the terminal when no output schema types it", async () => {
    const mcp = await connect(createApp());
    const result = await mcp.callTool("chart", {});
    await mcp.close();
    expect(result.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(result.structuredContent).toBeUndefined();
  });

  it("hides every write in read-only mode and refuses them if called anyway", async () => {
    const env = { NOTES_READ_ONLY: "1" };
    const app = createApp();
    const mcp = await connect(app, { env });
    const names = (await mcp.listTools()).map((tool) => tool.name);
    await mcp.close();
    expect(names).not.toContain("create_note");
    expect(names).not.toContain("delete_note");
    expect(names).toContain("get_note");
    await expect(app.invoke("create_note", { title: "x" }, { surface: "mcp", env })).rejects.toMatchObject({ code: "refused" });
  });

  it("loads only the toolsets that are switched on", async () => {
    const mcp = await connect(createApp(), { env: { NOTES_TOOLSETS: "reports" } });
    const names = (await mcp.listTools()).map((tool) => tool.name);
    await mcp.close();
    expect(names).not.toContain("export_all");
    expect(names).toContain("list_notes");
  });

  it("serves resources and prompts", async () => {
    const mcp = await connect(createApp());
    const resources = (await mcp.request("resources/list")) as { resources: Array<{ uri: string }> };
    const read = (await mcp.request("resources/read", { uri: "notes://about" })) as { contents: Array<{ text: string }> };
    const prompts = (await mcp.request("prompts/list")) as { prompts: Array<{ name: string }> };
    const prompt = (await mcp.request("prompts/get", { name: "summarize" })) as { messages: Array<{ content: { text: string } }> };
    await mcp.close();
    expect(resources.resources.map((resource) => resource.uri)).toEqual(["notes://about"]);
    expect(read.contents[0]!.text).toBe("Notes are short texts.");
    expect(prompts.prompts.map((p) => p.name)).toEqual(["summarize"]);
    expect(prompt.messages[0]!.content.text).toBe("Summarize my notes.");
  });

  it("sends the app's instructions at initialize", async () => {
    const mcp = await connect(createApp());
    await mcp.close();
    expect(mcp.initialize.instructions).toContain("delete_note runs only with confirm: true");
    expect(mcp.initialize.serverInfo).toMatchObject({ name: "notes", version: "1.0.0" });
  });
});

describe("search surface", () => {
  it("replaces a large catalog with three tools that find, describe and run it through the same guard", async () => {
    const store = createStore();
    const mcp = await connect(createApp(store), { env: { NOTES_SURFACE: "search" } });
    const names = (await mcp.listTools()).map((tool) => tool.name).sort();
    expect(names).toEqual(["call_tool", "describe_tool", "search_tools"]);

    const found = await mcp.callTool("search_tools", { query: "delete a note" });
    expect((resultData(found) as { tools: Array<{ name: string }> }).tools[0]!.name).toBe("delete_note");

    const described = await mcp.callTool("describe_tool", { name: "delete_note" });
    expect((resultData(described) as { requires_confirm: boolean }).requires_confirm).toBe(true);

    const refused = await mcp.callTool("call_tool", { name: "delete_note", arguments: { id: 2 } });
    expect(payload(refused)).toMatchObject({ code: "refused" });
    const done = await mcp.callTool("call_tool", { name: "delete_note", arguments: { id: 2 }, confirm: true });
    await mcp.close();
    expect(resultData(done)).toEqual({ deleted: 2 });
    expect(store.calls).toEqual(["delete_note 2"]);
  });
});
