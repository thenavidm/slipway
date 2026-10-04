# Changelog

What changed in Slipway, newest first.

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
