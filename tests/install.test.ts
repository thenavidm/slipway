import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, slipway } from "../src/index.js";
import { launchFor, planInstall, upsertCodexServer } from "../src/install.js";
import { cli } from "../src/testing.js";

function createApp() {
  return slipway({
    name: "notes",
    version: "2.3.4",
    package: "@example/notes-mcp-cli",
    instructions: "Notes: read and write notes.",
    settings: [
      { env: "NOTES_API_KEY", description: "API key from the notes dashboard.", secret: true },
      { env: "NOTES_REGION", description: "Which region's API to use." },
    ],
    context: () => ({}),
    tools: [defineTool({ name: "ping", title: "Ping", description: "Answer pong, to prove the server is alive.", risk: "read", handler: () => "pong" })],
  });
}

/** A home folder and a project folder of its own for each test. */
function place() {
  const root = mkdtempSync(join(tmpdir(), "slipway-install-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  return { home, project, env: { HOME: home, NOTES_API_KEY: "sk-notes-secret-1", NOTES_REGION: "eu" } as NodeJS.ProcessEnv };
}

function install(args: string[], where: ReturnType<typeof place>) {
  return cli(createApp(), ["install", ...args], { env: where.env, cwd: where.project });
}

const npx = ["--yes", "--package=@example/notes-mcp-cli@2.3.4", "notes-mcp"];
/** How this machine's clients will start the server: npx directly, or through cmd on Windows. */
const launch = launchFor(createApp(), { local: false });

describe("how a client starts the server", () => {
  it("names the package, its version and the MCP binary, since npx cannot pick between two binaries itself", () => {
    expect(launchFor(createApp(), { local: false, platform: "darwin" })).toEqual({ command: "npx", args: npx });
    expect(launchFor(createApp(), { local: false, platform: "win32" })).toEqual({ command: "cmd", args: ["/c", "npx", ...npx] });
    expect(launchFor(createApp(), { local: true, entry: "/opt/notes/dist/index.js" })).toEqual({ command: process.execPath, args: ["/opt/notes/dist/index.js"] });
  });
});

describe("install", () => {
  it("adds a Codex table that forwards the settings instead of holding them, and keeps every other server", async () => {
    const where = place();
    const file = join(where.home, ".codex", "config.toml");
    mkdirSync(join(where.home, ".codex"));
    writeFileSync(file, 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other-mcp"\n');
    const run = await install(["codex"], where);
    expect(run.code).toBe(0);
    const text = readFileSync(file, "utf8");
    expect(text).toBe(
      [
        'model = "gpt-5"',
        "",
        "[mcp_servers.other]",
        'command = "other-mcp"',
        "",
        "[mcp_servers.notes]",
        `command = ${JSON.stringify(launch.command)}`,
        `args = [${launch.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
        'env_vars = ["NOTES_API_KEY", "NOTES_REGION"]',
        "startup_timeout_sec = 60",
        "",
      ].join("\n"),
    );
    expect(text).not.toContain("sk-notes-secret-1");
    expect(readdirSync(join(where.home, ".codex")).some((name) => name.startsWith("config.toml.bak-"))).toBe(true);
    expect(run.stdout).toContain("Codex passes NOTES_API_KEY and NOTES_REGION on from its own environment: set them where you start Codex.");
  });

  it("updates a Codex table in place, keeping the person's own keys and subtables", () => {
    const before = [
      "[mcp_servers.notes]",
      'command = "old"',
      "args = [",
      '  "a",',
      '  "b",',
      "]",
      'env_vars = ["EXTRA_TOKEN"]',
      "tool_timeout_sec = 120",
      "",
      "[mcp_servers.notes.tools.delete_note]",
      'approval_mode = "prompt"',
      "",
      "[profiles.fast]",
      'model = "x"',
      "",
    ].join("\n");
    const after = upsertCodexServer(before, "notes", { command: "npx", args: npx }, ["NOTES_API_KEY"], true);
    expect(after).toBe(
      [
        "[mcp_servers.notes]",
        'command = "npx"',
        'args = ["--yes", "--package=@example/notes-mcp-cli@2.3.4", "notes-mcp"]',
        'env_vars = ["NOTES_API_KEY", "EXTRA_TOKEN"]',
        "startup_timeout_sec = 60",
        "tool_timeout_sec = 120",
        "",
        "[mcp_servers.notes.tools.delete_note]",
        'approval_mode = "prompt"',
        "",
        "[profiles.fast]",
        'model = "x"',
        "",
      ].join("\n"),
    );
    expect(() => upsertCodexServer('[mcp_servers]\nnotes = { command = "x" }\n', "notes", { command: "npx", args: [] }, [], false)).toThrow("form install does not rewrite");
    expect(() => upsertCodexServer('mcp_servers.notes.command = "x"\n', "notes", { command: "npx", args: [] }, [], false)).toThrow("form install does not rewrite");
  });

  it("gives Cursor and Gemini CLI references to read the settings from their own environment", async () => {
    const where = place();
    expect((await install(["cursor"], where)).code).toBe(0);
    expect((await install(["gemini", "--scope", "project"], where)).code).toBe(0);
    const cursor = JSON.parse(readFileSync(join(where.home, ".cursor", "mcp.json"), "utf8"));
    expect(cursor.mcpServers.notes).toEqual({ type: "stdio", ...launch, env: { NOTES_API_KEY: "${env:NOTES_API_KEY}", NOTES_REGION: "${env:NOTES_REGION}" } });
    const gemini = JSON.parse(readFileSync(join(where.project, ".gemini", "settings.json"), "utf8"));
    expect(gemini.mcpServers.notes.env).toEqual({ NOTES_API_KEY: "${NOTES_API_KEY}", NOTES_REGION: "${NOTES_REGION}" });
  });

  it("has VS Code ask for each credential once and store it securely", async () => {
    const where = place();
    await install(["vscode"], where);
    const config = JSON.parse(readFileSync(join(where.project, ".vscode", "mcp.json"), "utf8"));
    expect(config.inputs).toEqual([{ type: "promptString", id: "notes-api-key", description: "API key from the notes dashboard.", password: true }]);
    expect(config.servers.notes).toEqual({ type: "stdio", ...launch, env: { NOTES_API_KEY: "${input:notes-api-key}" } });
  });

  it("writes Claude Desktop's entry without credentials, unless asked to copy them, and then keeps the file private", async () => {
    if (process.platform !== "darwin" && process.platform !== "win32") return;
    const where = place();
    const plain = await install(["claude-desktop"], where);
    expect(plain.stdout).toContain("Claude Desktop does not read a shell's environment. Add NOTES_API_KEY and NOTES_REGION");
    const file = planInstall(createApp(), { client: "claude-desktop", scope: "user", name: "notes", copyEnv: false, local: false }, { env: where.env, cwd: where.project }).file!;
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers.notes.env).toBeUndefined();

    await install(["claude-desktop", "--copy-env"], where);
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers.notes.env).toEqual({ NOTES_API_KEY: "sk-notes-secret-1", NOTES_REGION: "eu" });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps what a person added to an entry by hand when installing again", async () => {
    const where = place();
    const file = join(where.home, ".cursor", "mcp.json");
    mkdirSync(join(where.home, ".cursor"));
    writeFileSync(file, JSON.stringify({ mcpServers: { notes: { command: "old", args: [], env: { NOTES_API_KEY: "typed-by-hand" }, disabled: false }, other: { command: "x" } } }));
    await install(["cursor"], where);
    const config = JSON.parse(readFileSync(file, "utf8"));
    expect(config.mcpServers.other).toEqual({ command: "x" });
    expect(config.mcpServers.notes).toEqual({ type: "stdio", ...launch, env: { NOTES_API_KEY: "typed-by-hand", NOTES_REGION: "${env:NOTES_REGION}" }, disabled: false });
  });

  it("shows the change with --dry-run and writes nothing", async () => {
    const where = place();
    const run = await install(["codex", "--dry-run"], where);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("would write");
    expect(run.stdout).toContain("[mcp_servers.notes]");
    expect(existsSync(join(where.home, ".codex"))).toBe(false);
  });

  it("hands Claude Code its own add-json command, and says how to run it when claude is missing", async () => {
    const where = place();
    const dry = await install(["claude-code", "--dry-run", "--json"], where);
    expect(JSON.parse(dry.stdout).run).toEqual({
      command: "claude",
      args: ["mcp", "add-json", "notes", JSON.stringify({ type: "stdio", ...launch }), "--scope", "user"],
    });
    const missing = await install(["claude-code"], { ...where, env: { ...where.env, PATH: "/nonexistent" } });
    expect(missing.code).toBe(2);
    expect(JSON.parse(missing.stderr).hint).toContain("claude mcp add-json notes");
  });

  it("refuses a file it cannot rewrite safely, a scope a client lacks, and an unknown client", async () => {
    const where = place();
    mkdirSync(join(where.project, ".vscode"));
    writeFileSync(join(where.project, ".vscode", "mcp.json"), '{\n  // my servers\n  "servers": {}\n}\n');
    const commented = await install(["vscode"], where);
    expect(commented.code).toBe(2);
    expect(JSON.parse(commented.stderr).error).toContain("not plain JSON");
    expect(JSON.parse((await install(["vscode", "--scope", "user"], where)).stderr).error).toBe("VS Code has no user scope here. It takes: project.");
    expect(JSON.parse((await install(["emacs"], where)).stderr).error).toBe("install expects one of: claude-code, codex, claude-desktop, cursor, vscode, gemini.");
  });
});
