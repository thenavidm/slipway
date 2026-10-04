import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cli } from "../src/testing.js";
import { createApp, createStore } from "./fixtures/notes.js";

const key = { NOTES_API_KEY: "sk-test-abcdef" };

describe("CLI: discovery", () => {
  it("lists every command, marks writes, and exits 0", async () => {
    const run = await cli(createApp(), []);
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/! delete-note\s+Delete a note/);
    expect(run.stdout).toMatch(/\* create-note\s+Create a note/);
    expect(run.stdout).toContain("notes-cli which <words>");
  });

  it("explains one command with its flags and a runnable example", async () => {
    const run = await cli(createApp(), ["get-note", "--help"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("Usage:\n  notes-cli get-note <id>");
    expect(run.stdout).toContain("notes-cli get-note 1");
    expect(run.stdout).toContain("Risk: read only");
  });

  it("prints the exact schema an MCP client receives", async () => {
    const run = await cli(createApp(), ["schema", "delete-note"]);
    const schema = JSON.parse(run.stdout);
    expect(schema.properties.confirm.type).toBe("boolean");
    expect(schema.required).toEqual(["id"]);
  });

  it("describes the whole CLI to an agent in one read", async () => {
    const run = await cli(createApp(), ["agent-context"]);
    const context = JSON.parse(run.stdout);
    expect(context.commands).toHaveLength(9);
    expect(context.usage.note).toContain("--agent never confirms");
    expect(context.exit_codes[10]).toBe("nothing configured");
    const get = context.commands.find((command: { command: string }) => command.command === "get-note");
    expect(get.examples[0].command).toBe("notes-cli get-note 1");
    expect(get.output_schema.type).toBe("object");
  });

  it("finds the command for a task described in words", async () => {
    const run = await cli(createApp(), ["which", "delete", "note"]);
    expect(run.stdout.split("\n")[0]).toContain("delete-note");
  });

  it("suggests the closest command for a typo and exits 2", async () => {
    const run = await cli(createApp(), ["get-nte", "1"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("Did you mean 'get-note'?");
  });

  it("prints the bare version, for scripts that compare it, and names the framework in agent-context", async () => {
    const run = await cli(createApp(), ["--version"]);
    expect(run.stdout).toBe("1.0.0\n");
    const context = JSON.parse((await cli(createApp(), ["agent-context"])).stdout);
    expect(context.framework).toMatchObject({ name: "slipway", version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
  });

  it("explains a built-in command with --help instead of running it", async () => {
    const install = await cli(createApp(), ["install", "--help"]);
    expect(install.code).toBe(0);
    expect(install.stdout).toContain("Usage: notes-cli install <client>");
    expect(install.stdout).toContain("claude-code");
    expect(install.stdout).toContain("--dry-run");
    const doctor = await cli(createApp(), ["doctor", "--help"]);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain("doctor [--network]");
  });

  it("generates shell completion from the same tool list", async () => {
    const bash = await cli(createApp(), ["completion", "bash"]);
    const fish = await cli(createApp(), ["completion", "fish"]);
    expect(bash.stdout).toContain("complete -F _notes_cli notes-cli");
    expect(bash.stdout).toContain("delete-note");
    expect(fish.stdout).toContain("-a 'get-note'");
  });
});

describe("CLI: running tools", () => {
  it("takes declared positionals and prints JSON", async () => {
    const run = await cli(createApp(), ["get-note", "2", "--json"]);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ id: 2, title: "Note 2", body: "Body 2" });
  });

  it("keeps only the selected fields", async () => {
    const run = await cli(createApp(), ["get-note", "--id", "1", "--select", "title", "--compact"]);
    expect(run.stdout).toBe('{"title":"Note 1"}\n');
  });

  it("prints a list as CSV, JSONL or bare ids", async () => {
    const csv = await cli(createApp(), ["list-notes", "--csv"]);
    expect(csv.stdout.split("\n")[0]).toBe("id,title,body");
    const lines = await cli(createApp(), ["list-notes", "--jsonl"]);
    expect(lines.stdout.trim().split("\n")).toHaveLength(3);
    const quiet = await cli(createApp(), ["list-notes", "--quiet"]);
    expect(quiet.stdout).toBe("1\n2\n3\n");
  });

  it("follows every page with --all, and stops at --max-items", async () => {
    const all = await cli(createApp(), ["list-notes", "--all", "--jsonl"]);
    expect(all.stdout.trim().split("\n")).toHaveLength(7);
    const some = JSON.parse((await cli(createApp(), ["list-notes", "--max-items", "4", "--json"])).stdout);
    expect(some.count).toBe(4);
    expect(some.items.map((note: { id: number }) => note.id)).toEqual([1, 2, 3, 4]);
    expect(some.next_cursor).not.toBeNull();
  });

  it("accepts arguments as one JSON object from a flag, a file or stdin, with flags overriding", async () => {
    const store = createStore();
    const fromFlag = await cli(createApp(store), ["create-note", "--input", '{"title":"From input"}', "--json"]);
    expect(JSON.parse(fromFlag.stdout).title).toBe("From input");
    const fromStdin = await cli(createApp(store), ["create-note", "--input", "-", "--title", "Flag wins", "--json"], {
      stdin: '{"title":"Ignored","body":"kept"}',
    });
    expect(JSON.parse(fromStdin.stdout)).toMatchObject({ title: "Flag wins", body: "kept" });
  });

  it("collects repeated flags into a list", async () => {
    const run = await cli(createApp(), ["create-note", "--title", "Tagged", "--tags", "a", "--tags", "b"]);
    expect(run.code).toBe(0);
  });

  it("validates a contract tool with the same schema as MCP", async () => {
    const run = await cli(createApp(), ["rename-note", "--id", "1", "--title", ""]);
    expect(run.code).toBe(2);
    expect(JSON.parse(run.stderr).code).toBe("usage");
  });

  it("reports a missing required argument by its flag and exits 2", async () => {
    const run = await cli(createApp(), ["create-note"]);
    expect(run.code).toBe(2);
    expect(JSON.parse(run.stderr).error).toBe("Missing --title.");
  });
});

describe("CLI: safety", () => {
  it("refuses an irreversible command without --confirm, even in agent mode or with --yes", async () => {
    const store = createStore();
    for (const extra of [[], ["--agent"], ["--yes"]]) {
      const run = await cli(createApp(store), ["delete-note", "2", ...extra]);
      expect(run.code).toBe(2);
      expect(JSON.parse(run.stderr)).toMatchObject({ code: "refused" });
      expect(run.stderr).toContain("--confirm");
    }
    expect(store.calls).toEqual([]);
  });

  it("runs it with --confirm", async () => {
    const store = createStore();
    const run = await cli(createApp(store), ["delete-note", "2", "--confirm", "--compact"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('{"deleted":2}\n');
  });

  it("shows what would run with --dry-run and runs nothing", async () => {
    const store = createStore();
    const run = await cli(createApp(store), ["delete-note", "3", "--dry-run", "--json"]);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ dry_run: true, tool: "delete_note", summary: "delete note 3", would_run: { id: 3 } });
    expect(store.calls).toEqual([]);
  });

  it("requires --confirm on a paid read, and hides it when its toolset is off", async () => {
    const refused = await cli(createApp(), ["export-all"]);
    expect(refused.code).toBe(2);
    const ok = await cli(createApp(), ["export-all", "--confirm", "--select", "count", "--compact"]);
    expect(ok.stdout).toBe('{"count":7}\n');
    const off = await cli(createApp(), ["export-all", "--confirm"], { env: { NOTES_TOOLSETS: "reports" } });
    expect(off.code).toBe(2);
    expect(JSON.parse(off.stderr).hint).toContain("NOTES_TOOLSETS");
  });

  it("refuses writes in read-only mode with the setting that controls it", async () => {
    const run = await cli(createApp(), ["create-note", "--title", "x"], { env: { NOTES_READ_ONLY: "1" } });
    expect(run.code).toBe(2);
    expect(JSON.parse(run.stderr).hint).toContain("NOTES_READ_ONLY");
  });

  it("records every attempted write in the audit log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slipway-audit-"));
    const log = join(dir, "audit.jsonl");
    const env = { NOTES_AUDIT_LOG: log };
    await cli(createApp(), ["delete-note", "1"], { env });
    await cli(createApp(), ["delete-note", "1", "--confirm"], { env });
    const lines = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.outcome)).toEqual(["blocked: no confirm", "allowed", "done"]);
    expect(lines[0]).toMatchObject({ surface: "cli", tool: "delete_note", summary: "delete note 1" });
  });
});

describe("CLI: exit codes and files", () => {
  it("maps failures to the documented exit codes", async () => {
    expect((await cli(createApp(), ["get-note", "99"])).code).toBe(3);
    expect((await cli(createApp(), ["whoami"])).code).toBe(4);
    expect((await cli(createApp(), ["slow-report"])).code).toBe(5);
  });

  it("exits 10 from doctor when nothing is configured, and 0 when it is", async () => {
    const empty = await cli(createApp(), ["doctor", "--json"]);
    expect(empty.code).toBe(10);
    expect(JSON.parse(empty.stdout).checks.find((check: { name: string }) => check.name === "Credentials").ok).toBe(false);
    const ready = await cli(createApp(), ["doctor", "--json"], { env: key });
    expect(ready.code).toBe(0);
    expect(ready.stdout).not.toContain(key.NOTES_API_KEY);
  });

  it("writes --out to a new private file and never overwrites one", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "slipway-out-")), "notes.json");
    const first = await cli(createApp(), ["list-notes", "--all", "--out", file]);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout).saved).toBe(file);
    expect(JSON.parse(readFileSync(file, "utf8")).count).toBe(7);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const second = await cli(createApp(), ["list-notes", "--out", file]);
    expect(second.code).toBe(2);
    expect(second.stderr).toContain("already exists");
  });

  it("prints login instructions", async () => {
    const run = await cli(createApp(), ["login"]);
    expect(run.stdout).toContain("NOTES_API_KEY");
  });
});
