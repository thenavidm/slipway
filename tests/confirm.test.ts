import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connect, type ElicitAnswer, type ElicitRequest } from "../src/testing.js";
import { canAskPerson, confirmRoute, promptsItself } from "../src/confirm.js";
import { createApp, createStore } from "./fixtures/notes.js";

function payload(result: { content?: Array<{ type: string; text?: string }> }) {
  return JSON.parse(result.content?.[0]?.text ?? "null");
}

/** A person at the client, answering every form the same way and remembering what they were shown. */
function person(answer: ElicitAnswer) {
  const asked: ElicitRequest[] = [];
  return { asked, elicit: (request: ElicitRequest) => (asked.push(request), answer) };
}

const approve: ElicitAnswer = { action: "accept", content: { approve: true } };
const claudeCode = { name: "claude-code", version: "2.1.286" };

describe("confirmation routes", () => {
  it("lets Claude Code's own prompt confirm, asks any client that can show a form, and falls back to the flag", () => {
    const elicits = { elicitation: { form: {}, url: {} } };
    expect(confirmRoute("human", { ...claudeCode, capabilities: elicits }, true)).toBe("client");
    expect(confirmRoute("human", { ...claudeCode, capabilities: elicits }, false)).toBe("person");
    expect(confirmRoute("human", { name: "claude-code", version: "2.1.100", capabilities: elicits }, true)).toBe("person");
    expect(confirmRoute("human", { name: "codex-mcp-client", version: "0.159.3", capabilities: elicits }, true)).toBe("person");
    expect(confirmRoute("human", { name: "plain", capabilities: {} }, true)).toBe("flag");
    expect(confirmRoute("model", { ...claudeCode, capabilities: elicits }, true)).toBe("flag");
  });

  it("reads a bare elicitation capability as forms, and url mode alone as no forms", () => {
    expect(canAskPerson({ capabilities: { elicitation: {} } })).toBe(true);
    expect(canAskPerson({ capabilities: { elicitation: { url: {} } } })).toBe(false);
    expect(canAskPerson({ capabilities: {} })).toBe(false);
    expect(promptsItself({ name: "claude-code", version: "2.1.246" })).toBe(true);
    expect(promptsItself({ name: "claude-code", version: "2.1.245" })).toBe(false);
    expect(promptsItself({ name: "claude-code" })).toBe(false);
  });
});

for (const era of ["legacy", "modern"] as const) {
  describe(`a person confirms (${era} protocol)`, () => {
    it("asks the person, and runs only on their yes", async () => {
      const store = createStore();
      const someone = person(approve);
      const mcp = await connect(createApp(store), { era, elicit: someone.elicit });
      const result = await mcp.callTool("delete_note", { id: 1 });
      await mcp.close();

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ deleted: 1 });
      expect(someone.asked).toHaveLength(1);
      expect(someone.asked[0]!.message).toBe("Notes wants to delete note 1.\n\nThis is public or cannot be undone.");
      expect(someone.asked[0]!.requestedSchema).toMatchObject({
        type: "object",
        properties: { approve: { type: "boolean", default: false } },
        required: ["approve"],
      });
      expect(store.calls).toEqual(["delete_note 1"]);
    });

    it("asks even when the model passed confirm: true, because the model cannot speak for the person", async () => {
      const store = createStore();
      const someone = person({ action: "decline" });
      const mcp = await connect(createApp(store), { era, elicit: someone.elicit });
      const result = await mcp.callTool("delete_note", { id: 1, confirm: true });
      await mcp.close();
      expect(someone.asked).toHaveLength(1);
      expect(payload(result)).toMatchObject({ code: "refused" });
      expect(store.calls).toEqual([]);
    });

    it("refuses on a no, an unticked box, or a closed form, and says which", async () => {
      for (const [answer, words] of [
        [{ action: "decline" }, "The approval was declined"],
        [{ action: "accept", content: { approve: false } }, "without ticking Approve"],
        [{ action: "accept", content: {} }, "without ticking Approve"],
        [{ action: "accept", content: { approve: "true" } }, "without ticking Approve"],
        [{ action: "cancel" }, "closed without an answer"],
      ] as const) {
        const store = createStore();
        const mcp = await connect(createApp(store), { era, elicit: person(answer).elicit });
        const result = await mcp.callTool("delete_note", { id: 2 });
        await mcp.close();
        expect(result.isError).toBe(true);
        expect(payload(result)).toMatchObject({ code: "refused" });
        expect(payload(result).error).toContain(words);
        expect(payload(result).error).toContain("delete note 2");
        expect(store.calls).toEqual([]);
      }
    });

    it("trusts Claude Code's own approval prompt and asks nothing more", async () => {
      const store = createStore();
      const someone = person(approve);
      const mcp = await connect(createApp(store), { era, clientInfo: claudeCode, elicit: someone.elicit });
      const tool = (await mcp.listTools()).find((candidate) => candidate.name === "delete_note")!;
      const result = await mcp.callTool("delete_note", { id: 3 });
      await mcp.close();
      expect(tool._meta?.["anthropic/requiresUserInteraction"]).toBe(true);
      expect(result.structuredContent).toEqual({ deleted: 3 });
      expect(someone.asked).toHaveLength(0);
    });

    it("asks an older Claude Code, which may not prompt for the tool itself", async () => {
      const someone = person(approve);
      const mcp = await connect(createApp(), { era, clientInfo: { name: "claude-code", version: "2.1.100" }, elicit: someone.elicit });
      await mcp.callTool("delete_note", { id: 1 });
      await mcp.close();
      expect(someone.asked).toHaveLength(1);
    });

    it("falls back to confirm: true for a client that cannot ask a person", async () => {
      const store = createStore();
      const mcp = await connect(createApp(store), { era });
      const refused = await mcp.callTool("delete_note", { id: 4 });
      const done = await mcp.callTool("delete_note", { id: 4, confirm: true });
      await mcp.close();
      expect(payload(refused).error).toContain("confirm: true");
      expect(done.structuredContent).toEqual({ deleted: 4 });
    });

    it("lets the model confirm alone when the operator chose that, and stops asking anyone", async () => {
      const store = createStore();
      const someone = person(approve);
      const mcp = await connect(createApp(store), { era, env: { NOTES_CONFIRM: "model" }, elicit: someone.elicit });
      const refused = await mcp.callTool("delete_note", { id: 5 });
      const done = await mcp.callTool("delete_note", { id: 5, confirm: true });
      await mcp.close();
      expect(someone.asked).toHaveLength(0);
      expect(payload(refused)).toMatchObject({ code: "refused" });
      expect(done.structuredContent).toEqual({ deleted: 5 });
    });

    it("never asks a person to approve a call that would be refused anyway", async () => {
      const someone = person(approve);
      const mcp = await connect(createApp(), { era, env: { NOTES_ALLOW_DESTRUCTIVE: "0" }, elicit: someone.elicit });
      const result = await mcp.callTool("delete_note", { id: 1 });
      await mcp.close();
      expect(someone.asked).toHaveLength(0);
      expect(payload(result).error).toContain("NOTES_ALLOW_DESTRUCTIVE=0");
    });

    it("asks for a paid read too, and through call_tool on the search surface, even in Claude Code", async () => {
      const someone = person(approve);
      const mcp = await connect(createApp(), { era, clientInfo: claudeCode, env: { NOTES_SURFACE: "search" }, elicit: someone.elicit });
      const result = await mcp.callTool("call_tool", { name: "export_all", arguments: {} });
      await mcp.close();
      expect(someone.asked).toHaveLength(1);
      expect(someone.asked[0]!.message).toBe("Notes wants to export every note.\n\nThis has an effect that cannot be taken back.");
      expect(result.structuredContent).toMatchObject({ count: 7 });
    });
  });
}

describe("approvals cannot be faked or reused", () => {
  const accepted = { slipway_approval: { action: "accept", content: { approve: true } } };

  it("ignores an answer a client attached to a call nobody was asked about", async () => {
    const store = createStore();
    const someone = person({ action: "decline" });
    const mcp = await connect(createApp(store), { era: "modern", elicit: someone.elicit });
    const first = (await mcp.send("tools/call", { name: "delete_note", arguments: { id: 1 }, inputResponses: accepted })) as { resultType: string };
    await mcp.close();
    expect(first.resultType).toBe("input_required");
    expect(store.calls).toEqual([]);
  });

  it("runs once per approval, and only for the call that was approved", async () => {
    const store = createStore();
    const mcp = await connect(createApp(store), { era: "modern", elicit: person(approve).elicit });
    const asked = (await mcp.send("tools/call", { name: "delete_note", arguments: { id: 1 } })) as { requestState: string };

    const other = await mcp.send("tools/call", { name: "delete_note", arguments: { id: 2 }, inputResponses: accepted, requestState: asked.requestState });
    expect(payload(other as never).error).toContain("different call");

    const fresh = (await mcp.send("tools/call", { name: "delete_note", arguments: { id: 1 } })) as { requestState: string };
    const once = await mcp.send("tools/call", { name: "delete_note", arguments: { id: 1 }, inputResponses: accepted, requestState: fresh.requestState });
    const again = await mcp.send("tools/call", { name: "delete_note", arguments: { id: 1 }, inputResponses: accepted, requestState: fresh.requestState });
    await mcp.close();

    expect((once as { structuredContent: unknown }).structuredContent).toEqual({ deleted: 1 });
    expect(payload(again as never).error).toContain("already used");
    expect(store.calls).toEqual(["delete_note 1"]);
  });

  it("refuses state the server never signed before any handler runs", async () => {
    const store = createStore();
    const mcp = await connect(createApp(store), { era: "modern", elicit: person(approve).elicit });
    await expect(
      mcp.send("tools/call", { name: "delete_note", arguments: { id: 1 }, inputResponses: accepted, requestState: "v1.e30.AAAA" }),
    ).rejects.toThrow(/requestState/);
    await mcp.close();
    expect(store.calls).toEqual([]);
  });

  it("writes who confirmed each call to the audit log", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "slipway-confirm-")), "audit.jsonl");
    const env = { NOTES_AUDIT_LOG: log };
    for (const options of [{ elicit: person(approve).elicit }, { elicit: person({ action: "decline" }).elicit }, { clientInfo: claudeCode, elicit: person(approve).elicit }]) {
      const mcp = await connect(createApp(), { env, ...options });
      await mcp.callTool("delete_note", { id: 1 });
      await mcp.close();
    }
    const lines = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => [line.outcome, line.confirmed_by])).toEqual([
      ["asked a person", undefined],
      ["allowed", "person"],
      ["done", undefined],
      ["asked a person", undefined],
      ["blocked: person declined", undefined],
      ["allowed", "client"],
      ["done", undefined],
    ]);
  });
});
