# Working on Slipway

Slipway is a framework: every MCP server and CLI built on it inherits whatever
changes here. These are the rules for agents editing it. The README is for
people building on it.

## What's here

| Path | What it is |
|---|---|
| `src/app.ts` | `slipway()`: the app, its context, and `run`, the one path every call takes on both surfaces |
| `src/tool.ts` | `defineTool` and `toolkit`: the one definition both surfaces read |
| `src/schema.ts` | Standard Schema plumbing: `jsonSchema()`, validation, the `confirm` and `wait_seconds` controls, size and repeat detection |
| `src/guard.ts`, `src/policy.ts` | The write guard and the environment switches |
| `src/confirm.ts` | Who confirms a call over MCP: the client's own prompt, an approval form, or the flag, and the signed single-use approval state |
| `src/jobs.ts` | Job tools: waiting, status tools, the bounded registry of background jobs |
| `src/data.ts`, `src/sync.ts`, `src/pages.ts` | Local data on `node:sqlite`: the cache, synced lists, search, and following pages |
| `src/openapi.ts` | `fromOpenAPI` and `httpExecutor` |
| `src/install.ts` | `install`: each client's config file and format |
| `src/errors.ts` | Errors that carry their exit code |
| `src/result.ts`, `src/redact.ts` | Turning results into MCP content, and masking secrets |
| `src/server.ts`, `src/serve.ts`, `src/entry.ts` | The MCP surface, stdio and HTTP serving, and the binary dispatch |
| `src/cli/` | The CLI: flags, output shapes, help, `agent-context`, completion, dispatch, `data` and `install` |
| `src/check.ts`, `src/docs.ts`, `src/rpc.ts`, `src/bin.ts` | `slipway check`, `docs`, `inspect` and `openapi` |
| `src/testing.ts` | The helpers apps test with |
| `tests/fixtures/notes.ts` | A small app with one tool of every kind. Most tests run against it |
| `tests/fixtures/renders.ts`, `library.ts` | Apps for jobs, and for the cache and synced lists |

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Compile to `dist/`. The startup tests import `dist`, so build before testing |
| `npm test` | Every test |
| `npm run typecheck` | Types only |
| `node dist/bin.js check <module>` | The release gate against a built app |

## Decisions already made

- **One execution path.** The MCP handler and the CLI both call `app.run`. A rule that belongs on both surfaces goes there, never in one surface.
- **Two runtime dependencies**: `@modelcontextprotocol/server` and `zod`. Anything else is a cost every server built on Slipway pays at install time. Ajv is an optional peer used only by `slipway check`.
- **No protocol code by hand.** Transports, protocol eras and schema validation come from the official SDK.
- **Agent mode never confirms.** No flag, setting or default may grant confirmation except `confirm: true` or `--confirm` on the call itself, or a person through the client.
- **A person outranks the flag.** Where a client can ask a person, the model's `confirm: true` does not count. An approval counts only with the state Slipway signed when it asked, bound to the tool and arguments, used once. Never accept an elicitation answer without that state.
- **Local data never fails a call.** A cache that cannot be read is a miss, logged at debug. Credentials are masked before anything is written to disk.
- **Verify client behavior against the client.** Formats and flags for Claude Code, Codex, Cursor, VS Code, Gemini CLI and Claude Desktop come from each one's own docs or source, and from running the real client where it is installed.
- **Never exit before the handshake.** A server with nothing configured starts, lists its tools and explains what is missing.
- **Exit codes are a contract.** 0, 1, 2, 3, 4, 5, 7, 10 and 130 keep their meaning. Scripts depend on them.
- **Name no other project** in code, comments, docs or commits. Explain why Slipway does something, never by contrast with someone else.

## Writing

No em dashes. Short paragraphs. Comments explain why a line has to be the way it is, never what it does.

## Before calling a change done

- `npm run build && npm test` pass.
- A change to anything a client receives is covered by a test in `tests/mcp.test.ts`, on both protocol revisions where it can differ; a change to the CLI, in `tests/cli.test.ts`.
- `CHANGELOG.md` says what changed and why, newest first.
