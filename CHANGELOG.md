# Changelog

What changed in Slipway, newest first.

## 0.1.6, 2026-10-05: what Mastodon's move needed

- **`login` runs the app's own sign-in, with the words after it.** `mastodon-cli login mastodon.social --oob` hands `mastodon.social --oob` to Mastodon's flow, which registers an app on that instance and signs in. A flow given with `usage` and `help` shows them in help, `login --help` and `agent-context`, so nobody has to guess that it takes an instance.
- **Terminal commands beside the tools.** `commands` adds commands such as `logout` to the CLI only. Each is listed in help, `agent-context` and tab completion, `slipway check` fails one named like a built-in or a tool, and an MCP client never sees it.
- **Tuning stays out of the way.** A setting marked `tuning: true`, such as a timeout with a working default, is named on one line of help and left out of what `install` writes. On Mastodon, `install claude-code` told people to set 13 variables and now names the 6 that connect an account, and the general help is 64 tokens shorter.
- **`httpPort` sets the default port for `--http`.** A server that shipped another default, such as 8000, keeps it after the move; `<PREFIX>_HTTP_PORT` and `--port` still override it.
- **`doctorNetwork` calls the service on every `doctor`.** Doctor stays local unless `--network` is passed, which keeps it quick and spends no requests. Mastodon's most common failure is a token without the `write` scope, which only a request finds, and its docs have always told people to run plain `doctor` for it.
- **The MCP binary's help names the CLI binary for the command list.** `mastodon-mcp --help` said a bare `mastodon-mcp` lists the commands, when it starts the server. Every hint that says where to list the commands now names the CLI binary.
- **Advertised schemas leave out Zod 4's safe-integer bounds.** Zod 4 gives every whole number `maximum: 9007199254740991` and its negative unless the schema sets its own. They tell a client nothing, so they are left out of what it receives; three were in Mastodon's tool list. Validation still runs on the full schema.

## 0.1.5, 2026-10-04: what Bluesky's move found

- **A request that never got an answer exits 5.** A failed fetch, a refused connection or a DNS failure mapped to exit 1, "unexpected error", so a script that retries on 5 gave up instead. Bluesky 1.2.3 exited 5 for an unreachable host, 0.1.4 made it 1, and it is 5 again.
- **`--help` and `agent-context` list every variable Slipway reads**, `<PREFIX>_HTTP_PORT`, `_HOST`, `_TOKEN` and `_DEBUG` included. Bluesky's own help listed the HTTP ones before it moved.
- **A shorter general help.** An agent often reads it first and pays for it again on every later step. The header drops the description, the rarely needed commands share one line, and Slipway's own settings say only what they do: Bluesky's went from 780 tokens to 667.
- **The command list says `!` needs `--confirm`** when that is true of every command it lists.
- **The entry turns on Node's compile cache.** The README's `src/index.ts` loads the app after `module.enableCompileCache()`, so every launch after the first skips compiling it: Bluesky answers a client in 183 ms instead of 204. Node before 22.8 starts as before.
- **The README says what happens to a piped request after stdin closes.** The server stops without answering, as the MCP stdio binding asks; keep stdin open until you read the answer.

## 0.1.4, 2026-10-04: faster starts, cheaper results in Codex

- **A JSON Schema compiles on its tool's first call.** `jsonSchema()` compiled its validator as soon as a tool was defined, so a server paid for every schema before it could answer. On Teachable's 123 contract tools that held the first answer back by 118 ms. Building Stripe's 611 OpenAPI tools took 1,745 ms and now takes 69; GitHub's 1,230 took 646 ms and now take 60 (medians of three runs on one Mac). A tool's first call now compiles its own schema, a median of 3 ms on Stripe's and under 1 ms on GitHub's.
- **`slipway check` compiles every schema.** A schema that cannot compile, such as one with a broken `$ref`, used to stop the server at startup. It now fails the check, before release, and names the tool.
- **`--version` prints the bare version.** It printed `notes 1.0.0 (slipway 0.1.3)`, where every server built before Slipway prints `1.0.0`, so a script comparing versions broke on migration. `agent-context` still names the framework and its version.
- **`structuredContent` only for a tool with an output schema.** An object result went out as JSON text and again as `structuredContent`. Codex hands a model the structured copy in place of the text, as one escaped string, so on a measured Teachable call it read 211 more tokens than for the same JSON as text, and the copy also hid a `render` text or an image. An untyped result is now text alone; a typed one still carries its validated copy. `resultData()` in `@thenavidm/slipway/testing` reads either.
- **A built-in command explains itself with `--help`.** `install --help` failed asking for a client; it now lists the clients and flags. Every other built-in prints the general help instead of running.
- **Shorter CLI screens, measured in tokens.** An agent pays for every line it reads. On Teachable's 26 commands, counted with OpenAI's tokenizer: the command list went from 413 tokens to 335, a command's `--help` from 368 to 230, the general help from 802 to 639, and `agent-context --brief` from 2,200 to 912. A command's help now shows only the output flags that command can use, and the command list names the setting that turns hidden commands on.

## 0.1.3, 2026-10-04: npx picks the server by name

- **`slipway check` matches npm's real rule.** npx picks a binary named after the package only when the binaries point to different files. When they share one file it starts whichever one the registry lists first, and the registry does not keep the published order: 23 published servers listed their MCP binary first and still started the CLI. 0.1.2's order check could not catch that. The check now requires a binary named after the package on a file of its own, and the README shows the one-line `src/npx.ts` it runs.

## 0.1.2, 2026-10-04: clients always start the server

- **`slipway check` fails a package whose `npx -y` default is the CLI.** With several binaries on one file, npx starts the first one listed. A package that lists its CLI first hands every client launched with `npx -y <package>` the command list instead of a server. The check reads `package.json` and names the fix: list the MCP binary first.
- **`install` follows `@latest`.** Clients start `npx --package=<package>@latest <name>-mcp`, so they pick up every release on their next start. The binary is still named, so the order in `package.json` cannot pick the wrong one.

## 0.1.1, 2026-10-04: a safer install check

- **No stranger's package through npx.** An unrelated npm package owns the bare name `slipway`, so a bare `npx slipway` with nothing installed fetched and ran it. SKILL.md now checks the install with `npm ls @thenavidm/slipway`, and every command that may run before an install names the package: `npx -p @thenavidm/slipway slipway <command>`.

## 0.1.0, 2026-10-04: the first release

- **One definition, two surfaces.** `defineTool` describes a tool once; `slipway()` ships it as an MCP server tool and a CLI command under the same name. Both surfaces send every call through one function, so validation, the write guard, timeouts, cancellation and redaction cannot differ between them.
- **Built on the official MCP TypeScript SDK v2.** Stdio and Streamable HTTP serve clients on the 2025 protocol and on the 2026-07-28 revision from one server.
- **Write safety.** Three risk levels, `confirm` added automatically to irreversible tools, read-only mode, a switch for irreversible writes, and an append-only audit log that records who confirmed each call. Agent mode never confirms.
- **Confirmation a model cannot fake.** Over MCP a person approves every irreversible call: in Claude Code's own per-call prompt (2.1.246 and later), or in an approval form in any client with elicitation, on both protocol revisions. The model's `confirm: true` counts only where a client can do neither, or with `<PREFIX>_CONFIRM=model` for headless agents. Approvals are signed, bound to the exact call, and work once; the form's one field starts unticked and only an explicit yes counts.
- **Long-running jobs.** `job` on a tool adds `wait_seconds` and a generated `<name>_status` tool, for jobs a service runs or for a slow handler run in the background. Calls wait at most 55 seconds; the CLI's `--wait` waits to the end.
- **Local data.** Opt-in caching of reads per account, cleared by any write, and `data sync`, `data search`, `data sql` and `data clear` for an offline copy of any list, plus `local_search` and `local_sync` over MCP. One private SQLite file, from the SQLite built into Node.js.
- **OpenAPI.** `fromOpenAPI()` turns every operation of an OpenAPI 3 document into a tool, with risk from the method, tags as toolsets, references resolved within a size budget, and a hash pin; `httpExecutor()` calls the API with each parameter in its documented style. `slipway openapi` previews a document and prints its pin. Stripe's API (611 tools from 612 operations) and GitHub's (1,230 from 1,232) build into valid tools in about a second each; the operations left out are file uploads and raw text.
- **Install.** `<cli> install` adds the server to Claude Code, Codex, Claude Desktop, Cursor, VS Code or Gemini CLI in each one's own format, merges into an existing entry, keeps a backup, and passes credentials by reference.
- **Typed results.** Declared output schemas validate results and send them as `structuredContent`; object results are structured even without one.
- **Lean tool lists.** Schemas go out without the `$schema` dialect line, which clients assume anyway, and Slipway's own arguments carry one-line descriptions. Measured on Bluesky over a real connection: its tool list went from 46,312 bytes to 40,680.
- **Contract tools.** `jsonSchema({...})` brings a tool generated from an API contract into the same list as a Zod tool, OpenAPI formats included.
- **An agent-native CLI.** Flags from the schema, positionals, `--input` from a flag, file or stdin, `--json`, `--compact`, `--jsonl`, `--csv`, `--tsv`, `--quiet`, `--select`, `--out`, `--dry-run`, `--all` across pages, `which`, `schema`, `agent-context`, `doctor`, `login`, shell completion, and exit codes that carry their meaning.
- **Large catalogs.** Toolsets switched by environment, and a search surface of three tools that find, describe and run the rest.
- **A release gate.** `slipway check` tests names, descriptions, JSON Schema 2020-12 validity, schema size and repeated definitions, examples, instructions, MCP and CLI parity over a real handshake on both protocol revisions, the commands quoted in docs, a missing `package`, and that the built server starts with nothing configured. `slipway docs` and `slipway inspect` print the reference and the wire view.
- **Proven on two real servers.** A Zod-built server with 45 tools and a contract-built server with 123 moved onto Slipway with every tool name, title, description and annotation unchanged and all their existing tests passing.
