import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, slipway, z } from "../src/index.js";
import { checkApp, cli, connect } from "../src/testing.js";
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
    expect(run.stdout).toMatch(/^Risk: read$/m);
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

  it("answers with the help of a command well ahead of the rest, and only the list otherwise", async () => {
    // Asking which and then <command> --help cost Codex a request that guessing the name had saved.
    const tool = (name: string, title: string) => defineTool({ name, title, description: `${title} for the account.`, input: z.object({ id: z.string().describe("Its id.") }), risk: "read", handler: () => ({}) });
    const app = slipway({ name: "probe", version: "1.0.0", context: () => ({}), tools: [tool("refund_sale", "Refund a sale"), tool("list_sales", "List sales"), tool("get_sale", "Get a sale"), tool("get_sale_report", "Get a sale report")] });
    const clear = (await cli(app, ["which", "refund"])).stdout;
    expect(clear).toContain("Usage:");
    expect(clear).toContain("probe-cli refund-sale <id>");
    const close = (await cli(app, ["which", "get", "a", "sale"])).stdout;
    expect(close).not.toContain("Usage:");
  });

  it("says a title once when the description opens with it", async () => {
    const tool = (title: string, description: string) => defineTool({ name: title.toLowerCase().replace(/\W+/g, "_"), title, description, risk: "read", handler: () => ({}) });
    const app = slipway({
      name: "probe",
      version: "1.0.0",
      context: () => ({}),
      tools: [
        tool("Generate images", "Generate images. Consumes credits."),
        tool("Get a report", "Get a report on one post, with its totals."),
        tool("List forms", "Read every form on the site."),
      ],
    });
    const line = async (...words: string[]) => (await cli(app, ["which", ...words])).stdout.split("\n")[0];
    expect(await line("generate", "images")).toBe("  generate-images  Generate images.");
    expect(await line("report", "totals")).toBe("  get-a-report  Get a report on one post, with its totals.");
    expect(await line("list", "forms")).toBe("  list-forms  List forms: Read every form on the site.");
  });

  it("keeps each command on one line when its description has line breaks", async () => {
    const tool = (name: string, title: string, description: string) => defineTool({ name, title, description, risk: "read", handler: () => ({}) });
    const app = slipway({
      name: "probe",
      version: "1.0.0",
      context: () => ({}),
      tools: [
        // A summary line with no full stop, a sentence wrapped to a width, and a list after a blank line.
        tool("list_flows", "List saved flows", "List saved flows\nRead operation."),
        tool("list_deleted_media", "List deleted media", "List deleted media still inside the\nrestore window. Media is listed only while it can be restored."),
        tool("estimate_pricing", "Estimate pricing", "Estimate pricing by one of two methods:\n\n- by unit price\n- by history"),
      ],
    });
    const line = async (...words: string[]) => (await cli(app, ["which", ...words])).stdout.split("\n")[0];
    expect(await line("saved", "flows")).toBe("  list-flows  List saved flows");
    expect(await line("deleted", "media")).toBe("  list-deleted-media  List deleted media still inside the restore window.");
    expect(await line("estimate", "pricing")).toBe("  estimate-pricing  Estimate pricing by one of two methods:");
    expect((await cli(app, [])).stdout).not.toMatch(/inside the\n|\nRead operation|\n- by/);
  });

  it("lists only the close matches, at least three, so the answer costs less to read than the list", async () => {
    const tools = Array.from({ length: 12 }, (_, i) =>
      defineTool({ name: `get_post_report_${i}`, title: `Get post report ${i}`, description: `Read the report on post number ${i}, with its totals.`, risk: "read", handler: () => ({}) }),
    );
    const app = slipway({
      name: "probe",
      version: "1.0.0",
      context: () => ({}),
      tools: [defineTool({ name: "publish_staged", title: "Publish a staged post", description: "Publish a post that was staged earlier, by its container id.", risk: "write", handler: () => ({}) }), ...tools],
    });
    const out = (await cli(app, ["which", "publish", "a", "staged", "post"])).stdout;
    const lines = out.split("\n\n")[0]!.trim().split("\n");
    expect(lines[0]).toContain("publish-staged");
    // Twelve tools mention a post; the weak matches past the third are left out.
    expect(lines.length).toBe(3);
    // publish-staged is well ahead of the reports, so its help comes with the answer.
    expect(out).toContain("Usage:");
    const json = JSON.parse((await cli(app, ["which", "publish", "a", "staged", "post", "--json"])).stdout);
    expect(json).toHaveLength(3);
  });

  it("shows each command only the output flags it can use, since an agent pays for every line", async () => {
    const read = (await cli(createApp(), ["get-note", "--help"])).stdout;
    expect(read).toContain("--select");
    for (const flag of ["--wait", "--refresh", "--dry-run", "--jsonl", "--timeout"]) expect(read).not.toContain(flag);
    expect((await cli(createApp(), ["list-notes", "--help"])).stdout).toContain("--jsonl");
    const write = (await cli(createApp(), ["delete-note", "--help"])).stdout;
    expect(write).toContain("--dry-run");
    expect(write).toContain("--agent never adds it");
  });

  it("never lists --confirm as the only required flag, which reads as if nothing else were needed", async () => {
    // Wistia's import takes its URL as a flag or inside --payload, so no flag is required; a Required
    // section holding only --confirm sent Codex to read the schema as well, one more step.
    const app = slipway({
      name: "probe",
      version: "1.0.0",
      context: () => ({}),
      tools: [
        defineTool({ name: "import_media", title: "Import media", description: "Import a media file from a URL.", input: z.object({ url: z.string().optional().describe("The URL to import."), payload: z.string().optional().describe("The whole body instead.") }), risk: "destructive", summary: () => "import", handler: () => ({}) }),
        defineTool({ name: "delete_media", title: "Delete media", description: "Delete one media file.", input: z.object({ id: z.string().describe("The media id.") }), risk: "destructive", summary: () => "delete", handler: () => ({}) }),
      ],
    });
    const open = (await cli(app, ["import-media", "--help"])).stdout;
    expect(open).not.toContain("Required:");
    expect(open.slice(open.indexOf("Options:"))).toContain("--confirm");
    const pinned = (await cli(app, ["delete-media", "--help"])).stdout;
    expect(pinned.slice(pinned.indexOf("Required:"), pinned.indexOf("Options:"))).toContain("--confirm");
  });

  it("leaves the flags to each command's help, since an agent carries the general help through every step", async () => {
    const help = (await cli(createApp(), ["--help"])).stdout;
    expect(help).not.toContain("Flags:");
    expect(help).toContain("what one takes, and its flags");
  });

  it("says why commands are hidden and which setting lists them", async () => {
    const off = (await cli(createApp(), [], { env: { NOTES_TOOLSETS: "none" } })).stdout;
    expect(off).toContain("1 more command is in admin, off: NOTES_TOOLSETS=admin turns it on.");
    // With the paid read hidden, every `!` command needs --confirm and nothing else does, so the legend can say so.
    expect(off).toContain("! public or irreversible, needs --confirm");
    expect((await cli(createApp(), [])).stdout).not.toContain("needs --confirm");
    const readOnly = (await cli(createApp(), [], { env: { NOTES_READ_ONLY: "1" } })).stdout;
    expect(readOnly).toMatch(/\d+ writes are hidden by NOTES_READ_ONLY=1\./);
  });

  it("keeps agent-context --brief to what picks a command", async () => {
    const brief = JSON.parse((await cli(createApp(), ["agent-context", "--brief"])).stdout);
    expect(brief.settings).toBeUndefined();
    expect(brief.global_flags).toBeUndefined();
    expect(brief.exit_codes[10]).toBe("nothing configured");
    expect(brief.commands.find((command: { command: string }) => command.command === "delete-note")).toMatchObject({ risk: "destructive", requires_confirm: true });
    expect(brief.commands.find((command: { command: string }) => command.command === "get-note")).toEqual({ command: "get-note", title: expect.any(String) });
  });

  it("lists in agent-context every variable the server reads, and names the switches a person needs in --help", async () => {
    const help = (await cli(createApp(), ["--help"])).stdout;
    const context = JSON.parse((await cli(createApp(), ["agent-context"])).stdout);
    const listed = new Set(context.settings.map((setting: { env: string }) => setting.env));
    for (const name of ["READ_ONLY", "ALLOW_DESTRUCTIVE", "AUDIT_LOG", "TOOLSETS", "SURFACE", "TOOL_TIMEOUT_MS", "CONFIRM", "HTTP_PORT", "HTTP_HOST", "HTTP_TOKEN", "HTTP_ALLOWED_ORIGINS", "DEBUG"]) {
      expect(listed.has(`NOTES_${name}`)).toBe(true);
    }
    // The safety switches are named in the help; the rest are counted, and agent-context describes them.
    for (const name of ["READ_ONLY", "ALLOW_DESTRUCTIVE", "TOOLSETS"]) expect(help).toContain(`NOTES_${name}`);
    expect(help).toMatch(/And \d+ more, for tuning and --http: agent-context describes each\./);
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

describe("CLI: terminal commands an app adds", () => {
  const calls: Array<[string, string[]]> = [];
  const app = slipway({
    name: "probe",
    version: "1.0.0",
    context: () => ({}),
    tools: [defineTool({ name: "get_thing", title: "Get a thing", description: "Get one thing by its id, from the account.", input: z.object({ id: z.number() }), risk: "read", handler: () => ({}) })],
    login: (io, args) => {
      calls.push(["login", args]);
      io.stdout(`signed in to ${args[0]}\n`);
      return 0;
    },
    commands: [{ name: "logout", usage: "logout [<handle>]", help: "Forget a stored account.", run: (_io, args) => (calls.push(["logout", args]), 0) }],
  });

  it("passes login its words, and runs an app's own command with its words", async () => {
    expect((await cli(app, ["login", "mastodon.social"])).stdout).toContain("signed in to mastodon.social");
    // Global flags such as --json are taken out before the command sees its words.
    expect((await cli(app, ["logout", "alice", "--json"])).code).toBe(0);
    expect(calls).toEqual([["login", ["mastodon.social"]], ["logout", ["alice"]]]);
  });

  it("lists it in help, agent-context and completion, and explains it with --help", async () => {
    expect((await cli(app, ["--help"])).stdout).toContain("probe-cli logout [<handle>]");
    expect((await cli(app, ["logout", "--help"])).stdout).toContain("Forget a stored account.");
    const context = JSON.parse((await cli(app, ["agent-context"])).stdout);
    expect(context.extra_commands).toEqual([{ command: "logout", usage: "probe-cli logout [<handle>]", description: "Forget a stored account." }]);
    expect((await cli(app, ["completion", "bash"])).stdout).toContain("logout");
  });

  it("shows what a described sign-in takes, in help, login --help and agent-context", async () => {
    const signedIn: string[][] = [];
    const described = slipway({
      name: "probe",
      version: "1.0.0",
      context: () => ({}),
      tools: [],
      login: { usage: "login <instance>", help: "register an app on that instance and sign in", run: (_io, args) => (signedIn.push(args), 0) },
    });
    expect((await cli(described, ["--help"])).stdout).toMatch(/probe-cli login <instance> +register an app on that instance and sign in/);
    const help = await cli(described, ["login", "--help"]);
    expect(help.stdout).toContain("Usage: probe-cli login <instance>");
    expect(help.stdout).toContain("Register an app on that instance and sign in.");
    expect(signedIn).toEqual([]);
    const context = JSON.parse((await cli(described, ["agent-context"])).stdout);
    expect(context.extra_commands).toEqual([{ command: "login", usage: "probe-cli login <instance>", description: "register an app on that instance and sign in" }]);
    expect((await cli(described, ["login", "mastodon.social"])).code).toBe(0);
    expect(signedIn).toEqual([["mastodon.social"]]);
  });

  it("names tuning settings on one line of help and describes them in agent-context", async () => {
    const tuned = slipway({
      name: "probe",
      version: "1.0.0",
      context: () => ({}),
      tools: [],
      settings: [
        { env: "PROBE_TOKEN", description: "A token for the account.", secret: true },
        { env: "PROBE_TIMEOUT_MS", description: "Per-request deadline. Defaults to 30000.", tuning: true },
        { env: "PROBE_MAX_RETRIES", description: "Retries on 429 and 5xx. Defaults to 3.", tuning: true },
      ],
    });
    const help = (await cli(tuned, ["--help"])).stdout;
    expect(help).toContain("A token for the account.");
    // No tool writes, so the audit log and the confirm switch, which act only on writes, are left out.
    // Tuning and Slipway's own settings are counted, not named: agent-context names and describes each.
    expect(help).toContain("And 9 more, for tuning and --http: agent-context describes each.");
    expect(help).not.toContain("PROBE_TIMEOUT_MS");
    expect(help).not.toContain("debug lines on stderr");
    expect(help).not.toContain("Per-request deadline");
    const context = JSON.parse((await cli(tuned, ["agent-context"])).stdout);
    expect(context.settings.find((setting: { env: string }) => setting.env === "PROBE_TIMEOUT_MS").description).toBe("Per-request deadline. Defaults to 30000.");
  });
});

describe("the write switches", () => {
  const settingNames = async (app: Parameters<typeof cli>[0]) =>
    (JSON.parse((await cli(app, ["agent-context"])).stdout).settings as Array<{ env: string }>).map((setting) => setting.env);

  it("are left out for an app whose tools only read, where they would change nothing", async () => {
    const reader = slipway({
      name: "probe",
      version: "1.0.0",
      context: () => ({}),
      tools: [defineTool({ name: "list_notes", title: "List notes", description: "List every note, newest first.", input: z.object({}), risk: "read", handler: () => [] })],
    });
    const help = (await cli(reader, ["--help"])).stdout;
    for (const name of ["PROBE_READ_ONLY", "PROBE_ALLOW_DESTRUCTIVE", "PROBE_AUDIT_LOG", "PROBE_CONFIRM"]) {
      expect(help).not.toContain(name);
      expect(await settingNames(reader)).not.toContain(name);
    }
  });

  it("keep read-only and the audit log for a write, and the rest only once something cannot be undone", async () => {
    const write = defineTool({ name: "add_note", title: "Add a note", description: "Add a note to the list.", input: z.object({ text: z.string() }), risk: "write", handler: () => ({}) });
    const writer = slipway({ name: "probe", version: "1.0.0", context: () => ({}), tools: [write] });
    expect(await settingNames(writer)).toEqual(expect.arrayContaining(["PROBE_READ_ONLY", "PROBE_AUDIT_LOG"]));
    expect(await settingNames(writer)).not.toContain("PROBE_ALLOW_DESTRUCTIVE");
    expect(await settingNames(writer)).not.toContain("PROBE_CONFIRM");
    const remove = defineTool({ name: "delete_note", title: "Delete a note", description: "Delete a note for good.", input: z.object({ id: z.string() }), risk: "destructive", handler: () => ({}) });
    const deleter = slipway({ name: "probe", version: "1.0.0", context: () => ({}), tools: [write, remove] });
    expect(await settingNames(deleter)).toEqual(expect.arrayContaining(["PROBE_READ_ONLY", "PROBE_ALLOW_DESTRUCTIVE", "PROBE_AUDIT_LOG", "PROBE_CONFIRM"]));
    expect((await cli(deleter, ["--help"])).stdout).toContain("PROBE_ALLOW_DESTRUCTIVE=0");
  });
});

describe("a hidden command", () => {
  it("runs and is listed in agent-context, but stays out of the general help", async () => {
    const ran: string[][] = [];
    const app = slipway({
      name: "probe",
      version: "1.0.0",
      context: () => ({}),
      tools: [],
      commands: [{ name: "auth", help: "the same as login, by an older name", hidden: true, run: (_io, args) => (ran.push(args), 0) }],
    });
    expect((await cli(app, ["--help"])).stdout).not.toContain("probe-cli auth");
    expect((await cli(app, ["auth", "x"])).code).toBe(0);
    expect(ran).toEqual([["x"]]);
    const context = JSON.parse((await cli(app, ["agent-context"])).stdout);
    expect(context.extra_commands.map((command: { command: string }) => command.command)).toContain("auth");
  });
});

describe("destructive writes off, hidden rather than refused", () => {
  const app = () =>
    slipway({
      name: "post",
      version: "1.0.0",
      context: () => ({}),
      defaults: { destructiveOff: "hide" },
      tools: [
        defineTool({ name: "publish", title: "Publish", description: "Publish a post for everyone to see.", risk: "destructive", handler: () => ({ ok: true }) }),
        defineTool({ name: "draft", title: "Draft", description: "Save a draft only you can see.", risk: "write", handler: () => ({ ok: true }) }),
        defineTool({ name: "read_post", title: "Read", description: "Read a post back.", risk: "read", handler: () => ({ ok: true }) }),
      ],
    });
  const off = { POST_ALLOW_DESTRUCTIVE: "0" };

  it("leaves them out of both surfaces and says why", async () => {
    const mcp = await connect(app(), { env: off });
    const names = (await mcp.listTools()).map((tool) => tool.name).sort();
    await mcp.close();
    expect(names).toEqual(["draft", "read_post"]);
    const list = await cli(app(), [], { env: off });
    expect(list.stdout).toContain("1 irreversible write is hidden by POST_ALLOW_DESTRUCTIVE=0.");
    const run = await cli(app(), ["publish", "--confirm"], { env: off });
    expect(run.code).toBe(2);
    expect(JSON.parse(run.stderr)).toMatchObject({ code: "refused" });
    expect(run.stderr).toContain("POST_ALLOW_DESTRUCTIVE=0 hides the irreversible writes");
  });

  it("lists them as usual when destructive writes are on", async () => {
    const mcp = await connect(app(), { env: {} });
    expect((await mcp.listTools()).length).toBe(3);
    await mcp.close();
  });
});

describe("CLI: help printed by the MCP binary", () => {
  it("sends a person to the CLI binary for the command list, since the bare MCP binary serves", async () => {
    const app = createApp();
    let out = "";
    let err = "";
    const io = { stdout: (text: string) => void (out += text), stderr: (text: string) => void (err += text), stdin: async () => "", env: {}, isTTY: false, bin: app.bins.mcp };
    await app.runCli(["--help"], io);
    expect(out).toMatch(/^ {2}notes-cli +list the commands$/m);
    expect(out).toContain("notes-mcp doctor");
    expect(await app.runCli(["no-such-command"], io)).toBe(2);
    expect(err).toContain("Run `notes-cli` to list commands, or `notes-cli which <words>` to find one.");
  });
});

describe("CLI: doctor that always calls the service", () => {
  const probe = (doctorNetwork?: boolean) => {
    const seen: boolean[] = [];
    const app = slipway({
      name: "probe",
      version: "1.0.0",
      context: () => ({}),
      tools: [],
      ...(doctorNetwork === undefined ? {} : { doctorNetwork }),
      doctor: (_ctx, { network }) => (seen.push(network), [{ name: "Scopes", ok: true, detail: network ? "read write follow" : "not checked" }]),
    });
    return { app, seen };
  };

  it("calls the service on plain doctor when the app asks, and says nothing about --network", async () => {
    const { app, seen } = probe(true);
    const run = await cli(app, ["doctor"]);
    expect(seen).toEqual([true]);
    expect(run.stdout).toContain("read write follow");
    expect(run.stdout).not.toContain("--network");
    expect((await cli(app, ["--help"])).stdout).toMatch(/probe-cli doctor +check the setup/);
  });

  it("leaves the service alone by default until --network is passed", async () => {
    const { app, seen } = probe();
    expect((await cli(app, ["doctor"])).stdout).toContain("run with --network to call the service");
    await cli(app, ["doctor", "--network"]);
    expect(seen).toEqual([false, true]);
  });
});

describe("CLI: doctor's own words", () => {
  const reader = (context: () => unknown) =>
    slipway({
      name: "reader",
      version: "1.0.0",
      context,
      tools: [defineTool({ name: "get_note", title: "Get a note", description: "Read one note by its id.", input: z.object({ id: z.string() }), risk: "read", handler: () => ({}) })],
    });

  it("says an app that only reads has no writes, rather than that they are on", async () => {
    const run = await cli(reader(() => ({})), ["doctor"]);
    expect(run.stdout).toMatch(/Writes +none: every tool only reads/);
  });

  it("points a setting it cannot read at login, not back at doctor, and says a setting needs fixing", async () => {
    const run = await cli(reader(() => { throw new Error("READER_ACCOUNTS must be a JSON array."); }), ["doctor"]);
    expect(run.code).toBe(10);
    expect(run.stdout).toContain("READER_ACCOUNTS must be a JSON array.");
    expect(run.stdout).toContain("Run `reader-cli login` for what to set.");
    expect(run.stdout).not.toContain("reader-cli doctor` to see");
    expect(run.stdout).toContain("A setting needs fixing.");
  });
});

describe("a write whose arguments decide its risk", () => {
  const audit = join(mkdtempSync(join(tmpdir(), "slipway-riskfor-")), "audit.jsonl");
  const saved: string[] = [];
  const app = slipway({
    name: "blog",
    version: "1.0.0",
    context: () => ({}),
    tools: [
      defineTool({
        name: "save_post",
        title: "Save a post",
        description: "Save a post as a draft, or publish it, which everyone can read at once.",
        input: z.object({ title: z.string(), status: z.enum(["draft", "publish"]).default("draft") }),
        risk: "destructive",
        riskFor: (args) => (args.status === "publish" ? "destructive" : "write"),
        handler: (args) => (saved.push(`${args.status}:${args.title}`), { saved: args.status }),
      }),
    ],
  });
  const env = { BLOG_AUDIT_LOG: audit };

  it("saves a draft without --confirm and refuses to publish without it", async () => {
    expect((await cli(app, ["save-post", "--title", "a", "--status", "draft"], { env })).code).toBe(0);
    const refused = await cli(app, ["save-post", "--title", "b", "--status", "publish"], { env });
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stderr).code).toBe("refused");
    expect((await cli(app, ["save-post", "--title", "c", "--status", "publish", "--confirm"], { env })).code).toBe(0);
    expect(saved).toEqual(["draft:a", "publish:c"]);
    const risks = readFileSync(audit, "utf8").trim().split("\n").map((line) => JSON.parse(line)).map((entry) => `${entry.risk} ${entry.outcome}`);
    expect(risks).toEqual(["write allowed", "write done", "destructive blocked: no confirm", "destructive allowed", "destructive done"]);
  });

  it("keeps drafts with irreversible writes switched off, and still lists the highest risk", async () => {
    const off = { BLOG_ALLOW_DESTRUCTIVE: "0" };
    expect((await cli(app, ["save-post", "--title", "d", "--status", "draft"], { env: off })).code).toBe(0);
    expect((await cli(app, ["save-post", "--title", "e", "--status", "publish", "--confirm"], { env: off })).code).toBe(2);
    expect((await cli(app, [], { env: off })).stdout).toMatch(/! save-post/);
  });

  it("is refused on a read, which has no risk to decide", () => {
    expect(() =>
      defineTool({ name: "get_post", title: "Get a post", description: "Read one post by its id.", risk: "read", riskFor: () => "write", handler: () => ({}) }),
    ).toThrow(/riskFor/);
  });
});

describe("a tool's own consequence, and a switch that would do nothing", () => {
  const app = slipway({
    name: "shop",
    version: "1.0.0",
    context: () => ({}),
    tools: [
      defineTool({
        name: "refund_order",
        title: "Refund an order",
        description: "Refund an order in full, which sends the money back to the buyer at once.",
        input: z.object({ order: z.string() }),
        risk: "destructive",
        consequence: "moves money and cannot be undone.",
        summary: (args) => `Refund order ${String(args.order)}.`,
        handler: () => ({ refunded: true }),
      }),
    ],
  });

  it("says what the refused call does, in the tool's own words", async () => {
    const run = await cli(app, ["refund-order", "--order", "9"]);
    expect(run.code).toBe(2);
    expect(JSON.parse(run.stderr).error).toMatch(/^refund_order moves money and cannot be undone, so it will not run without --confirm/);
    // A summary that ends its own sentence is not given a second period.
    expect(JSON.parse(run.stderr).error).toContain("About to: Refund order 9. Call again");
  });

  it("leaves out <PREFIX>_TOOLSETS when no tool has a toolset", async () => {
    expect((await cli(app, ["--help"])).stdout).not.toContain("SHOP_TOOLSETS");
    const context = JSON.parse((await cli(app, ["agent-context"])).stdout);
    expect(context.settings.map((setting: { env: string }) => setting.env)).not.toContain("SHOP_TOOLSETS");
    expect((await cli(createApp(), ["--help"])).stdout).toContain("NOTES_TOOLSETS");
  });
});

describe("a call that spends money", () => {
  const app = slipway({
    name: "studio",
    version: "1.0.0",
    context: () => ({}),
    tools: [
      defineTool({
        name: "imagine",
        title: "Generate an image",
        description: "Generate four images from a prompt, which costs GPU time from the plan.",
        input: z.object({ prompt: z.string() }),
        risk: "write",
        spends: true,
        handler: () => ({ job: "j1" }),
      }),
      defineTool({ name: "list_jobs", title: "List jobs", description: "List recent generation jobs, newest first.", risk: "read", handler: () => [] }),
    ],
  });

  it("needs --confirm, says it spends money, and is marked $ in the list", async () => {
    const refused = await cli(app, ["imagine", "--prompt", "a lighthouse"]);
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stderr).error).toMatch(/^imagine spends money and cannot be refunded, so it will not run without --confirm/);
    expect((await cli(app, ["imagine", "--prompt", "a lighthouse", "--confirm"])).code).toBe(0);
    const list = (await cli(app, [])).stdout;
    expect(list).toMatch(/\$ imagine/);
    expect(list).toContain("$ spends money, needs --confirm");
  });

  it("is refused with STUDIO_ALLOW_DESTRUCTIVE=0, even confirmed, yet clients see a plain write", async () => {
    const off = await cli(app, ["imagine", "--prompt", "a lighthouse", "--confirm"], { env: { STUDIO_ALLOW_DESTRUCTIVE: "0" } });
    expect(off.code).toBe(2);
    expect(JSON.parse(off.stderr).hint).toContain("paid calls");
    expect((await cli(app, ["--help"])).stdout).toContain("refuse the irreversible writes and paid calls");
    const mcp = await connect(app);
    const tool = (await mcp.listTools()).find((candidate) => candidate.name === "imagine")!;
    await mcp.close();
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(tool._meta?.["anthropic/requiresUserInteraction"]).toBe(true);
    const context = JSON.parse((await cli(app, ["agent-context", "--brief"])).stdout);
    expect(context.commands.find((command: { command: string }) => command.command === "imagine")).toMatchObject({ requires_confirm: true, spends: true });
  });

  it("is refused on a read", () => {
    expect(() => defineTool({ name: "peek", title: "Peek", description: "Look at one job by its id.", risk: "read", spends: true, handler: () => ({}) })).toThrow(/cannot spend/);
  });
});

describe("login printed as steps", () => {
  it("answers login --help with the steps, not the general help", async () => {
    const app = slipway({ name: "keys", version: "1.0.0", context: () => ({}), tools: [], login: "Set KEYS_API_KEY to a key from the dashboard." });
    const help = await cli(app, ["login", "--help"]);
    expect(help.stdout.trim()).toBe("Set KEYS_API_KEY to a key from the dashboard.");
  });
});

describe("an app's own vocabulary", () => {
  const app = slipway({
    name: "studio",
    version: "1.0.0",
    context: () => ({}),
    flagAliases: { ar: "aspect", sref: "style_refs" },
    synonyms: { picture: ["image"], make: ["generate", "imagine"], redo: ["rerun_job"] },
    tools: [
      defineTool({
        name: "imagine",
        title: "Generate images",
        description: "Generate four images from a prompt and wait for them.",
        input: z.object({ prompt: z.string(), aspect: z.string().optional().describe("Aspect ratio."), style_refs: z.array(z.string()).optional().describe("Style references.") }),
        risk: "write",
        handler: (args) => args,
      }),
      defineTool({ name: "vary_image", title: "Vary an image", description: "Make variations of one generated image.", input: z.object({ id: z.string() }), risk: "write", handler: () => ({}) }),
      defineTool({ name: "rerun_job", title: "Run a job again", description: "Submit the same job again with the same settings.", input: z.object({ id: z.string() }), risk: "write", handler: () => ({}) }),
      defineTool({ name: "list_jobs", title: "List jobs", description: "List recent jobs with their images.", risk: "read", handler: () => ({ count: 2, jobs: [{ id: "a", noise: 1 }, { id: "b", noise: 2 }], images: ["u1"] }) }),
    ],
  });

  it("takes the ecosystem's flag spellings and shows them in help", async () => {
    const run = await cli(app, ["imagine", "a lighthouse", "--ar", "16:9", "--sref", "123", "--json"]);
    expect(JSON.parse(run.stdout)).toEqual({ prompt: "a lighthouse", aspect: "16:9", style_refs: ["123"] });
    expect((await cli(app, ["imagine", "--help"])).stdout).toContain("--aspect, --ar");
  });

  it("finds a tool by the words people use, and nothing for a query of filler", async () => {
    expect((await cli(app, ["which", "make", "a", "picture"])).stdout.split("\n")[0]).toContain("imagine");
    expect((await cli(app, ["which", "redo", "that", "one"])).stdout.split("\n")[0]).toContain("rerun-job");
    expect((await cli(app, ["which", "the", "of", "and"])).stdout).toContain("No command matches");
  });

  it("selects inside the one list a result holds, and keeps the rest", async () => {
    const run = await cli(app, ["list-jobs", "--select", "id", "--compact"]);
    expect(JSON.parse(run.stdout)).toEqual({ count: 2, jobs: [{ id: "a" }, { id: "b" }], images: ["u1"] });
  });

  it("fails check on an alias no input takes, and warns on a synonym no tool uses", async () => {
    const broken = slipway({ ...app.definition, flagAliases: { q: "quality" }, synonyms: { art: ["painting"] } });
    const report = await checkApp(broken, {});
    expect(report.findings.some((finding) => finding.level === "error" && finding.message.includes("--q points at 'quality'"))).toBe(true);
    expect(report.findings.some((finding) => finding.level === "warn" && finding.message.includes("'painting'"))).toBe(true);
  });
});

describe("an app command that reads a flag Slipway also has", () => {
  it("gets its own --out, where it declares it, and global flags are still taken out", async () => {
    const seen: string[][] = [];
    const app = slipway({
      name: "rec",
      version: "1.0.0",
      context: () => ({}),
      tools: [],
      commands: [{ name: "capture", usage: "capture [--seconds N] [--out <file>]", help: "record what the app calls", flags: ["--out", "--seconds"], run: (_io, args) => (seen.push(args), 0) }],
    });
    expect((await cli(app, ["capture", "--seconds", "30", "--out", "calls.json", "--json"])).code).toBe(0);
    expect(seen).toEqual([["--seconds", "30", "--out", "calls.json"]]);
  });
});
