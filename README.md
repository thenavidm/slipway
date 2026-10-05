<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://cdn.navid.me/repos/slipway-logo-light.png">
  <img src="https://cdn.navid.me/repos/slipway-logo-dark.png" alt="Slipway" width="88">
</picture>

# Slipway: MCP Server & CLI Framework

[![npm](https://img.shields.io/npm/v/@thenavidm/slipway?color=orange&label=npm)](https://www.npmjs.com/package/@thenavidm/slipway)
[![CI](https://github.com/thenavidm/slipway/actions/workflows/ci.yml/badge.svg)](https://github.com/thenavidm/slipway/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-green)](./LICENSE)
[![YouTube](https://img.shields.io/badge/YouTube-@thenavidm-red?logo=youtube&logoColor=white)](https://youtube.com/@thenavidm?sub_confirmation=1)
[![X](https://img.shields.io/badge/X-@thenavidm-black?logo=x)](https://x.com/thenavidm)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-thenavidm-0A66C2?logo=linkedin&logoColor=white)](https://linkedin.com/in/thenavidm)

TypeScript framework for MCP servers and CLIs, for Claude Code, Codex and AI agents. Describe each tool once and Slipway ships it as an MCP server tool and a command line command, with write safety, typed results and release checks built in.

The two surfaces cannot drift apart. They are generated from the same tool list, and every call on either one runs through the same code: the same validation, the same guard, the same errors.

Built and maintained by [Navid Moazzez](https://navid.me?utm_source=github&utm_medium=referral&utm_campaign=slipway&utm_content=readme).

## Two ways to use it

Every server built on Slipway ships both, from one definition like this:

```ts
import { defineTool, slipway, z } from "@thenavidm/slipway";

const deleteNote = defineTool({
  name: "delete_note",
  title: "Delete a note",
  description: "Delete a note forever. There is no undo and no trash.",
  input: z.object({ id: z.number().int().describe("The note id.") }),
  risk: "destructive",
  positional: ["id"],
  summary: ({ id }) => `delete note ${id}`,
  handler: ({ id }, ctx) => ctx.api.deleteNote(id),
});

export const app = slipway({
  name: "notes",
  version: "1.0.0",
  context: (env) => ({ api: new NotesApi(env.NOTES_API_KEY) }),
  tools: [deleteNote],
});
```

### Command line

`<name>-cli` runs every tool as a command, with flags derived from the same JSON Schema the model reads. It is built for agents as much as for people: one flag for machine output, exit codes a script can branch on, field selection, dry runs and a full description of itself as JSON.

```bash
notes-cli                                  # every command, writes marked
notes-cli which remove a note              # find the command for a task
notes-cli get-note 7 --select title --compact
notes-cli list-notes --all --jsonl         # follow every page, one record per line
notes-cli delete-note 7                    # refused: irreversible, so it needs --confirm
notes-cli delete-note 7 --dry-run          # what would run, without running it
notes-cli agent-context                    # commands, flags, risk and exit codes as JSON
```

### MCP server, for your AI app

`<name>-mcp` is what Claude Code, Codex, Claude Desktop and Cursor launch. It serves MCP over stdio, or over Streamable HTTP with `--http`, and answers clients on the 2025 protocol and on the 2026-07-28 revision from one server. `<name>-cli install codex` adds it to a client in one step.

Every tool goes out with the annotations its risk implies, so a client that auto-approves reads or prompts on writes gets an honest answer from every tool. An irreversible call waits for a person to approve it, wherever the client can ask one.

### Which one

| Where you are | What you can reach |
|---|---|
| An agent that runs shell commands, like Claude Code or Codex | Both. The CLI costs nothing until a command runs |
| A chat app with no shell, like claude.ai or Claude Desktop | The MCP server only |
| A terminal, a script, cron or CI | The CLI only |

They are the same program reading the same tool definitions, so anything one can do, the other can.

## Features

- **One definition, two surfaces.** A tool added today is a command today, under the same name, with the same arguments.
- **Write safety that holds on both surfaces.** Three risk levels, confirmation for irreversible calls, a read-only switch, a switch that blocks irreversible writes, and an audit log. Agent mode never confirms anything.
- **Confirmation a model cannot fake.** A person approves every irreversible call: in Claude Code's own prompt, in an approval form in any other client that can show one, and through the model's `confirm: true` only where a client can do neither. An approval is signed, bound to the exact call, and works once.
- **Long-running jobs.** A tool that starts a render or an export waits a bounded time, then hands back a job to check with a generated status tool, so no client gives up on it. In a terminal, `--wait` waits to the end.
- **Local data.** Reads can opt in to a cache, kept per account and cleared by any write. `data sync`, `data search` and `data sql` keep an offline, searchable copy of any list, in one private SQLite file with nothing to install.
- **OpenAPI to tools.** `fromOpenAPI()` turns every operation in a document into a tool, with the risk its method implies, its tags as toolsets, and a hash pin that refuses a changed document. It turns 611 of the 612 operations in Stripe's API into tools, and 1,230 of GitHub's 1,232; the rest are file uploads or raw text.
- **One command to install.** `<cli> install codex`, or `claude-code`, `claude-desktop`, `cursor`, `vscode` or `gemini`, adds the server to that client's own configuration and passes credentials on instead of writing them down.
- **Typed results.** Declare an output schema and results also go out as validated `structuredContent`. Without one, a result is compact text alone: Codex reads a structured copy in place of the text, and on a measured call that cost 211 more tokens.
- **Contract tools.** A tool built from a pinned JSON contract joins the same list as a hand-written Zod tool, with `jsonSchema({...})`.
- **Toolsets and a search surface** for large catalogs, so a client loads only what a person turns on.
- **Typed errors and exit codes.** Every error carries its exit code and a hint: JSON on stderr in a terminal, a readable error result over MCP.
- **Secrets stay out.** Registered credentials, and any field named like one, are masked in every result and error.
- **A release gate.** `slipway check` tests schemas, sizes, examples, MCP and CLI parity, the commands your docs mention, and that the built server starts with nothing configured.
- **Light.** Two runtime dependencies: the official MCP SDK and Zod. Local data uses the SQLite built into Node.js.

## Contents

| # | Section | What it covers |
|---|---|---|
| 1 | [Install](#1-install) | Requirements and the local install |
| 2 | [Build a server](#2-build-a-server) | The three files every server needs |
| 3 | [Tools](#3-tools) | Every field of `defineTool`, results, errors, contract tools |
| 4 | [Safety](#4-safety) | Risk levels, approval by a person, read-only mode, the audit log |
| 5 | [Long-running jobs](#5-long-running-jobs) | Jobs, status tools and waiting |
| 6 | [Local data](#6-local-data) | The cache, synced lists, offline search and SQL |
| 7 | [OpenAPI](#7-openapi) | Every operation in a document as a tool, pinned |
| 8 | [The CLI](#8-the-cli) | Commands, flags, output shapes and exit codes |
| 9 | [The MCP server](#9-the-mcp-server) | Transports, HTTP security, resources and prompts |
| 10 | [Add it to a client](#10-add-it-to-a-client) | `install` for six clients, and what each does with credentials |
| 11 | [Large catalogs](#11-large-catalogs) | Toolsets and the search surface |
| 12 | [Release checks](#12-release-checks) | `slipway check`, `docs`, `inspect` and `openapi` |
| 13 | [Testing](#13-testing) | In-memory MCP and CLI helpers, both protocol eras |
| 14 | [Troubleshooting](#14-troubleshooting) | Symptoms, causes and fixes |
| 15 | [FAQ](#15-faq-) | Twenty-five questions, answered |

## 1. Install

Slipway needs Node.js 22 or later, and ESM. Local data uses the SQLite built into Node.js 22.13 and later; on an older release everything else works and the cache stays off.

```bash
npm install @thenavidm/slipway
npm install --save-dev ajv
```

`ajv` is optional and only used by `slipway check`, to validate schemas against JSON Schema 2020-12, the check Claude Code runs before it accepts a tool. It never ships to your users.

## 2. Build a server

A server is three files, plus a one-line fourth for npx.

**`src/tools.ts`** says what the server can do. `toolkit<Context>()` binds the context type once, so every handler gets `ctx.api` typed:

```ts
import { toolkit, z } from "@thenavidm/slipway";
import type { Context } from "./app.js";

const { defineTool } = toolkit<Context>();

export const getNote = defineTool({
  name: "get_note",
  title: "Get a note",
  description: "Read one note by its id, with its full body.",
  input: z.object({ id: z.number().int().min(1).describe("The note id.") }),
  output: z.object({ id: z.number(), title: z.string(), body: z.string() }),
  risk: "read",
  positional: ["id"],
  examples: [{ description: "Read note 7", args: { id: 7 } }],
  handler: ({ id }, ctx) => ctx.api.getNote(id, { signal: ctx.signal }),
});
```

**`src/app.ts`** describes the server and never starts it, so tests and `slipway check` can import it:

```ts
import { slipway } from "@thenavidm/slipway";
import { NotesApi } from "./api.js";
import { getNote } from "./tools.js";

export type Context = { api: NotesApi; key?: string };

export const app = slipway<Context>({
  name: "notes",
  title: "Notes",
  version: "1.0.0",
  instructions: "Notes: read and manage notes. delete_note needs confirm: true.",
  context: (env) => ({ api: new NotesApi(env.NOTES_API_KEY), key: env.NOTES_API_KEY }),
  configured: (ctx) => Boolean(ctx.key),
  secrets: (ctx) => [ctx.key],
  settings: [{ env: "NOTES_API_KEY", description: "A key from the notes dashboard.", secret: true }],
  login: "Set NOTES_API_KEY to a key from the notes dashboard.",
  tools: [getNote],
});
```

**`src/index.ts`** is both binaries:

```ts
#!/usr/bin/env node
import * as nodeModule from "node:module";

nodeModule.enableCompileCache?.();
const { app } = await import("./app.js");
await app.main();
```

The app loads after Node's compile cache goes on, so every launch after the first skips compiling it again: Bluesky answers a client in 183 ms instead of 204. Node before 22.8 has no compile cache and starts as before, and `NODE_DISABLE_COMPILE_CACHE=1` turns it off.

**`src/npx.ts`** is what `npx -y @you/notes-mcp-cli` runs:

```ts
#!/usr/bin/env node
import "./index.js";
```

```json
{
  "bin": { "notes-mcp": "dist/index.js", "notes-cli": "dist/index.js", "notes-mcp-cli": "dist/npx.js" }
}
```

npx picks a binary named after the package only when the binaries point to different files. When they all share one file it starts whichever one the registry lists first, and the registry does not keep the order they were published in, so a client could get the CLI's command list instead of a server. The fourth binary, on its own file, is picked every time, and `slipway check` fails a package without it.

`notes-mcp` with no arguments serves MCP over stdio and stays silent on stdout. `notes-cli` with no arguments lists the commands. Any argument on either binary is a command, so a typo is reported instead of starting a server that waits on stdin.

The context is built on the first call that needs it, never at startup, and so is each tool's JSON Schema validator: Stripe's 611 generated tools are ready in about 70 ms. `--help` works with nothing configured, and the server answers a client at once and explains what is missing instead of exiting.

## 3. Tools

| Field | What it does |
|---|---|
| `name` | snake_case. The MCP tool name; the CLI command is the same name with dashes |
| `title` | A few words for pickers and the command list |
| `description` | What it does and when to use it. The only documentation a model reads before calling |
| `input` | A Zod object, or `jsonSchema({...})` for a tool generated from an API contract |
| `output` | Optional. Results are validated against it and sent as `structuredContent` |
| `risk` | `read`, `write` (easy to undo) or `destructive` (public, irreversible, or both) |
| `requireConfirm` | Defaults to true for destructive tools. Set it on a write that spends money |
| `riskFor` | `(args) => risk`, when the arguments decide it: publishing is destructive, saving a draft is a write. `risk` stays the highest, which clients see; the guard, confirmation and audit log go by the call |
| `spends` | The call spends money or credits, a paid generation: it needs confirming, `<PREFIX>_ALLOW_DESTRUCTIVE=0` refuses it, and the CLI marks it `$`, while clients still see a write |
| `consequence` | What a confirmed call does, in the tool's own words for the refusal and the approval form: "moves money and cannot be undone". Defaults to "is public or cannot be undone" |
| `idempotent`, `openWorld` | Annotation hints. Reads are idempotent by default; every tool is open world unless it never leaves the machine |
| `tags` | Toolsets this tool belongs to. A tool with no tags is always on |
| `summary` | One line for the refusal message and the audit log: "delete note 7" |
| `preview` | What `--dry-run` prints. Defaults to the validated arguments |
| `examples` | Arguments as a client sends them. Shown as runnable commands in help and checked by `slipway check` |
| `positional` | Inputs that may be typed as bare words, in order |
| `paginate` | How the tool pages, so `--all` and `--max-items` can follow every page |
| `job` | The tool starts work that outlasts a call. See [Long-running jobs](#5-long-running-jobs) |
| `cache` | `{ ttlSeconds }`: keep this read's results locally for a while. See [Local data](#6-local-data) |
| `sync` | `{ id }`: this read lists records worth an offline copy |
| `timeoutMs` | Abort the call after this long |
| `maxResultChars` | This tool's results are legitimately large; raises Claude Code's limit for it |
| `render` | Text for the result when JSON is not the best way to read it |
| `handler` | `(args, ctx) => result`. `ctx` is your context plus `signal`, `surface`, `env`, `progress`, `log` and `secrets` |

A handler returns plain data. An object goes out as compact JSON text, and as typed `structuredContent` too when the tool declares `output`. Return `content([...], data)` with `image()`, `audio()`, `file()` or `resourceLink()` for anything that is not text.

Throw one of the error classes and the caller gets its exit code. `httpError(status, message)` maps an HTTP status in one line, and `UsageError`, `NotFoundError`, `AuthError`, `RateLimitError`, `ApiError` and `NotConfiguredError` cover the rest.

A tool built from a pinned contract joins the same list. To make a tool of every operation in an API, see [OpenAPI](#7-openapi).

```ts
import { defineTool, jsonSchema } from "@thenavidm/slipway";

export const renameCourse = defineTool({
  name: "rename_course",
  title: "Rename a course",
  description: "Change a course's name. Generated from the Admin API contract.",
  input: jsonSchema<{ id: number; name: string }>({
    type: "object",
    properties: { id: { type: "integer", format: "int32" }, name: { type: "string" } },
    required: ["id", "name"],
    additionalProperties: false,
  }),
  risk: "write",
  handler: ({ id, name }, ctx) => ctx.api.patch(`/courses/${id}`, { name }),
});
```

## 4. Safety

Shipping no writes is not safety: it hands the work back to a person. Shipping them unguarded is worse. So every write works, and the irreversible ones need a confirmation the caller gives on purpose.

| Risk | Example | Guard |
|---|---|---|
| `read` | List posts | None |
| `write` | Like a post, add a label | Off in read-only mode |
| `destructive` | Publish, delete, block | Needs confirming. Off in read-only mode, and off when irreversible writes are switched off |

`confirm: true` is something a model types, so on its own it proves only that the model meant it. Over MCP, Slipway asks the person instead, wherever the client can ask one:

| Client | Who confirms an irreversible call |
|---|---|
| Claude Code 2.1.246 and later | The person, in Claude Code's own approval prompt, which it shows on every call in every permission mode |
| Any other client that supports elicitation, such as Codex | The person, in an approval form: the call runs only if they tick Approve and accept |
| A client that can do neither | The model, with `confirm: true` |

The form's answer comes back from the client as data, so Slipway counts it only next to the state it signed when it asked, which names the exact tool and arguments and works once. A client cannot approve a call nobody was asked about, reuse an approval, or move one to other arguments. The form's one field starts unticked and only an explicit yes counts, so a client that answers forms by itself cannot approve anything.

In a terminal, `--confirm` on the command itself confirms. The refusal names the exact thing to type on the surface the caller is on, and says what was about to happen, from the tool's `summary`.

`--agent` turns on JSON, compact output, no prompts and no color. It never confirms anything, and neither does `--yes`, which is accepted only so scripts written for other tools keep working. The agent that sets those flags is exactly the caller confirmation exists for.

Three switches belong to whoever runs the server, under the server's own prefix:

| Setting | Effect |
|---|---|
| `<PREFIX>_READ_ONLY=1` | Every write disappears from both surfaces, and a direct call is refused |
| `<PREFIX>_ALLOW_DESTRUCTIVE=0` | Writes stay, irreversible ones are refused |
| `<PREFIX>_AUDIT_LOG=<file>` | Every attempted write is appended to this file, with its outcome and who confirmed it |
| `<PREFIX>_CONFIRM=model` | `confirm: true` alone confirms, and nobody is asked. For an agent with no person to ask |

A headless agent has nobody to answer an approval. Claude Code run with `-p` refuses a tool that needs a person, and Codex run with `exec` declines the form. Set `<PREFIX>_CONFIRM=model` for those runs, and keep `<PREFIX>_READ_ONLY=1` for any agent that should never write.

## 5. Long-running jobs

A client stops waiting on a tool after about a minute, and Codex after 60 seconds by default. A render, an export or a long sync cannot simply run inside one call. Declare `job` and Slipway adds a `wait_seconds` argument, waits that long, and generates `<name>_status` to check on the job later.

A job the service runs, with its own status endpoint:

```ts
export const renderVideo = defineTool({
  name: "render_video",
  title: "Render a video",
  description: "Render a video from a script. Rendering takes several minutes.",
  input: z.object({ script: z.string().describe("What the video says.") }),
  risk: "write",
  job: {
    id: "id",
    status: (id, ctx) => ctx.api.getRender(id, { signal: ctx.signal }),
    done: (render) => render.state === "done" || render.state === "failed",
    failed: (render) => render.state === "failed",
    progress: (render) => ({ progress: render.percent, total: 100 }),
  },
  handler: ({ script }, ctx) => ctx.api.startRender(script),
});
```

A handler that is slow on its own runs in the background with `job: { background: true }`. Slipway keeps its result for an hour, in the server that ran it.

| What the caller sees | When |
|---|---|
| `{ job_id, done: true, status }`, or `result` for a background job | The job finished within the wait |
| `{ job_id, done: false, status, check }` | It is still running. `check` says how to ask again |
| An error with the service's status as its details | `failed` says the job failed |

`wait_seconds` defaults to 25 and stops at 55, under the minute clients allow. Progress reaches a client that asked for it while a call waits. In a terminal, `--wait` waits to the end however long it takes, and a background job always does, since the command's process is all that keeps it alive.

```bash
notes-cli render-video --script "Hello" --wait
notes-cli render-video-status r_123 --wait
```

## 6. Local data

An agent that asks the same question twice should not pay the service twice, and a person searching 10,000 records should not page through an API to do it. Each app keeps one SQLite file on this machine for both. The folder is readable by its owner only, and so is the file.

**The cache.** A read with `cache: { ttlSeconds: 300 }` answers a repeated call from the file. Answers are kept per account, so switching keys never shows one account another's data, and any write through the same app clears them, so a read after a write is fresh. Over MCP a cached result carries `_meta["slipway/cache"]` with its age. In a terminal, `--refresh` fetches again, and `<PREFIX>_CACHE=0` turns the cache off.

**Synced lists.** A list tool with `sync: { id: "id" }` can be copied, every page of it, and searched offline:

```bash
notes-cli data sync list-notes                     # copy every page
notes-cli data search grocery list                 # full-text, accents ignored
notes-cli data sql "select json_extract(data, '$.title') from records where tool = 'list_notes'"
notes-cli data                                     # what is kept, where, for which account
notes-cli data clear list-notes                    # delete that copy
```

A sync with no filters mirrors the list, so records the service no longer lists are removed. A filtered sync only adds and updates. Over MCP, `local_sync` copies a list in the background and `local_search` searches the copy; both are in the `local` toolset.

Records are stored with registered credentials masked, `data sql` runs on a connection SQLite itself will not write through, and the file lives under `<PREFIX>_DATA_DIR` or the system's own data folder. Set `dataScope` on the app to keep data per account id rather than per key, so rotating a key keeps the copy.

## 7. OpenAPI

An API that publishes OpenAPI 3 already says what every operation takes. `fromOpenAPI()` turns each operation into a tool, and `httpExecutor()` calls it:

```ts
import { fromOpenAPI, httpExecutor, slipway } from "@thenavidm/slipway";
import spec from "./openapi.json" with { type: "json" };

export const app = slipway<{ token: string }>({
  name: "shop",
  version: "1.0.0",
  context: (env) => ({ token: env.SHOP_TOKEN ?? "" }),
  secrets: (ctx) => [ctx.token],
  tools: fromOpenAPI(spec, {
    execute: httpExecutor({ baseUrl: "https://api.example.com/v1", headers: (ctx) => ({ authorization: `Bearer ${ctx.token}` }) }),
    pin: { sha256: "26620d73f4fcf9a84c6729a0d005cf973dd68a010e439df88c30f54480922739" },
  }),
});
```

| From the document | Becomes |
|---|---|
| `operationId` | The tool name in snake_case. A name past 64 characters ends in a short hash, so it stays unique |
| The HTTP method | The risk: GET is a read, DELETE is irreversible and needs confirming, the rest are writes |
| Tags | Toolsets |
| Path, query and header parameters, and a JSON or form body | One input, with a plain body's fields spread into it. A name already taken, such as a body field called `confirm`, becomes `body_confirm` |
| References, `nullable`, `example`, 3.0's exclusive bounds | JSON Schema 2020-12. A schema that refers to itself is cut, and objects more than three references deep are described rather than spelled out |

Override any operation's name or risk with `names` and `risk`, keep a subset with `include`, and add `typedOutput: true` to declare documented responses as output schemas. `httpExecutor` writes each parameter in the style its document gives, maps failures to Slipway's errors with the API's own message, and refuses to send credentials over plain HTTP to another machine. A body that is a file upload or raw text is skipped, and `slipway openapi` says which and why.

`pin` refuses to build from a document that changed since someone reviewed it. `slipway openapi openapi.json` prints the hash to pin, every tool the document becomes, and any schema large enough to cost a model real context.

## 8. The CLI

| Command | What it does |
|---|---|
| `<cli>` | Every command, grouped by toolset, writes marked |
| `<cli> <command> [flags]` | Run one tool |
| `<cli> <command> --help` | Its flags, choices, defaults, examples and risk |
| `<cli> which <words>` | Find the command for a task, by what it does. An app's `synonyms` add the words its users type: `{ picture: ["image"] }` |
| `<cli> schema <command>` | The JSON Schema an MCP client receives. `--output` for the result's |
| `<cli> agent-context` | Commands, flags, risk, examples, exit codes and settings as JSON. `--brief` for just the commands, which ones write or need `--confirm`, and the exit codes |
| `<cli> doctor` | Check the setup. `--network` also calls the service, which an app with `doctorNetwork` does every time |
| `<cli> login` | How to connect an account: printed steps, or the app's own sign-in flow with the words after `login` |
| `<cli> install <client>` | Add the MCP server to a client. See [Add it to a client](#10-add-it-to-a-client) |
| `<cli> data` | The local cache and synced lists: `sync`, `search`, `sql`, `clear` |
| `<cli> <command>` from `commands` | A terminal command the app adds, such as `logout`. Listed in help and `agent-context`, never sent to an MCP client |
| `<cli> completion bash` | Tab completion for bash, zsh or fish |

Flags come from the schema: `--flag value`, `--flag=value`, the underscore spelling, any name an app's `flagAliases` gives (`{ ar: "aspect" }` for `--ar 16:9`), `--no-flag` for a boolean, repeated or comma-separated lists of numbers and choices, and JSON or `@file.json` for an object. `--input` takes every argument as one JSON object, from the flag, a file or stdin, and flags on the same line override it.

| Output flag | Shape |
|---|---|
| `--json` | Pretty JSON |
| `--compact` | One line of JSON |
| `--jsonl` | One JSON value per line, for lists |
| `--csv`, `--tsv` | A table, for lists of records |
| `--quiet` | One value per line: ids, or the one `--select` field |
| `--select a,b.c` | Keep only these fields. Dotted paths descend into arrays, and a field not at the top selects inside the one list a result holds, keeping the rest |
| `--out <file>` | Write to a new file, readable only by you, never over an existing one |
| `--wait` | For a job: wait until it finishes |
| `--refresh` | Skip the local cache and fetch again |

| Exit code | Meaning |
|---|---|
| 0 | Ok |
| 1 | Unexpected error |
| 2 | Usage error, or a write the guard refused |
| 3 | Not found |
| 4 | Authentication or permission |
| 5 | Upstream API error or timeout |
| 7 | Rate limited |
| 10 | Nothing configured |

Errors are JSON on stderr, always, with `error`, `code` and a `hint` that names the fix.

## 9. The MCP server

| Run | Serves |
|---|---|
| `<mcp>` | MCP over stdio, what a client launches |
| `<mcp> --http [--port 8787]` | Streamable HTTP at `/mcp`, with `/health`. The app's `httpPort` replaces 8787, for a server that shipped another default |

HTTP binds `127.0.0.1` and checks the Host header, so a web page cannot reach it through a name that resolves to localhost, and it refuses a request whose Origin is another site unless `<PREFIX>_HTTP_ALLOWED_ORIGINS` lists it, as the MCP transport spec asks. It refuses to listen on any other address without `<PREFIX>_HTTP_TOKEN`, because anyone who reached the port would act as your account.

Work that belongs to a running server goes in `onServe(ctx, log)`, which runs once the server is answering over either transport and never for a CLI command: a queue that publishes on time, or a warning that a token expires this week. A throw there is logged and the server keeps serving.

Resources and prompts are optional and take a few lines each:

```ts
resources: [{ name: "guide", uri: "notes://guide", mimeType: "text/markdown", read: () => GUIDE }],
prompts: [{ name: "weekly-review", description: "Review this week's notes.", render: () => "Review my notes from this week." }],
```

## 10. Add it to a client

`install` adds the server to a client's own configuration, in the shape that client expects:

```bash
notes-cli install codex
notes-cli install claude-code --scope project
notes-cli install claude-desktop --copy-env
notes-cli install cursor --dry-run
```

| Client | Where it goes | How credentials reach the server |
|---|---|---|
| `claude-code` | `claude mcp add-json`, user or project scope | Claude Code passes its own environment on |
| `codex` | `~/.codex/config.toml`, or `.codex/config.toml` | Listed in `env_vars`, so Codex forwards them from its environment |
| `claude-desktop` | `claude_desktop_config.json` | Claude Desktop sees no shell environment, so you add them, or `--copy-env` copies them in and makes the file private |
| `cursor` | `~/.cursor/mcp.json`, or `.cursor/mcp.json` | `${env:NAME}` references |
| `vscode` | `.vscode/mcp.json` | VS Code asks for each credential once and stores it securely |
| `gemini` | `~/.gemini/settings.json`, or `.gemini/settings.json` | `${NAME}` references, which Gemini CLI needs to pass anything named like a key |

A published server is started with `npx --package=<package>@latest <name>-mcp`, so a client picks up every release on its next start, with Codex's startup timeout raised for the download. The binary is named, because npx alone starts whichever binary a package lists first. Without `package`, or with `--local`, the client starts this copy on disk. Installing again updates the entry in place: anything you added to it by hand stays, and the old file is kept as a backup. A setting marked `tuning: true`, such as a timeout with a working default, stays out of the entry, so it carries only what connects an account.

## 11. Large catalogs

A server with a hundred tools costs a client that loads every definition up front on every message. Two settings keep that down.

**Toolsets.** Tag tools, then let whoever runs the server pick: `<PREFIX>_TOOLSETS=courses,users`, or `all`. Untagged tools are always on. `defaults.toolsets` sets what is on when the variable is unset, and can be a function of the environment, which keeps an older switch like `ENABLE_BETA=1` working.

**The search surface.** `<PREFIX>_SURFACE=search` replaces the tool list with three tools: `search_tools` finds a tool by what it does, `describe_tool` returns one schema, and `call_tool` runs it through the same guard. The CLI is unaffected.

## 12. Release checks

`slipway check` runs against your built app and its real MCP server:

```bash
npx slipway check dist/app.js --bin dist/index.js --docs README.md,SKILL.md
```

Run it in a project that has `@thenavidm/slipway` installed, where npx uses that copy. Anywhere else, name the package: `npx -p @thenavidm/slipway slipway openapi spec.json`. A bare `npx slipway` with nothing installed fetches an unrelated npm package of the same name.

| Check | What fails |
|---|---|
| Names | A tool that takes a built-in command's name |
| Descriptions | A description too thin to choose a tool by; arguments with no description |
| Schemas | Not valid JSON Schema 2020-12, a property name a client rejects, a root-level union |
| Size | A schema over the budget, and definitions repeated inside one schema |
| Examples | An example whose arguments the schema rejects |
| Safety | A confirmed tool with no summary for its refusal and audit line |
| Instructions | None, or 512 characters that never say what the server is |
| Parity | A tool, schema, annotation or approval flag that differs between MCP and the CLI |
| Docs | A command or flag in your README or SKILL.md that does not exist |
| Startup | A built server that exits or hangs when nothing is configured |
| Install | No `package`, or a package.json whose `npx -y` default starts the CLI instead of the server |

Parity runs on both protocol revisions a client may open with. `slipway docs dist/app.js` prints the command table, every argument and the settings as Markdown, from the same definitions. `slipway inspect dist/app.js` lists the tools exactly as a client receives them, and `slipway openapi <file|url>` previews what an OpenAPI document becomes.

## 13. Testing

```ts
import { checkApp, cli, connect, resultData } from "@thenavidm/slipway/testing";

const mcp = await connect(app, { env: { NOTES_API_KEY: "test" } });
const note = resultData(await mcp.callTool("get_note", { id: 7 }));
await mcp.close();

const { code } = await cli(app, ["delete-note", "7"], { env: {} });
// code is 2: refused without --confirm

const report = await checkApp(app, { env: {} });
```

`connect` talks to the real server over an in-memory transport, through the same stdio entry the binary runs. `resultData` reads what a call returned, typed or not. `cli` runs the real CLI with captured output. To stub the network, build the app with a context that returns a fake client.

To test approval by a person, give `connect` an `elicit` answer, and pass `era: "modern"` for the 2026-07-28 revision or `clientInfo` to be a particular client:

```ts
const mcp = await connect(app, { era: "modern", elicit: () => ({ action: "accept", content: { approve: true } }) });
```

## 14. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| A tool is missing from the list | Read-only mode hides writes, or its toolset is off | Check `<PREFIX>_READ_ONLY` and `<PREFIX>_TOOLSETS`, or run `<cli> doctor` |
| A destructive call keeps being refused | No confirmation on the call itself | Pass `confirm: true`, or `--confirm` in a terminal. `--agent` and `--yes` never confirm |
| A headless agent cannot run an irreversible tool | Nobody is there to approve it | Set `<PREFIX>_CONFIRM=model` for that run, so `confirm: true` confirms |
| A job tool returns `done: false` | The job outlasted the wait | Call its `_status` tool with the `job_id`, or use `--wait` in a terminal |
| A background job's status says not found | The server that ran it restarted, or an hour passed | Start the job again |
| A read returns old data | It is cached | `--refresh`, or `<PREFIX>_CACHE=0`. A write through the app clears the cache |
| `data` says SQLite is missing | Node.js older than 22.13 | Upgrade Node.js. Everything but local data works meanwhile |
| `tools/list` fails with a schema error | A schema written with Zod 3 | Use Zod 4.2 or later, imported from Slipway so the app has one copy |
| Exit code 10 | Nothing is configured | Run `<cli> login` and `<cli> doctor` |
| A client shows the server as failed | The process printed to stdout, which is the protocol channel | Log with `ctx.log`, which writes to stderr |
| Codex stops a long call after 60 seconds | Codex's default tool timeout | Make it a job tool, or raise `tool_timeout_sec` for the server in Codex's `config.toml` |
| Codex shows the server as failed at startup | The first npx download outlasted 10 seconds | `install codex` sets `startup_timeout_sec = 60`; add it by hand to an older entry |
| `slipway check` warns about schema size | One tool's schema is large or repeats its definitions | Send the body schema once, or advertise a short one and validate the full one in the handler |
| `slipway check` cannot load the app | The module starts the server when imported | Export the app from `app.ts` and call `app.main()` only in `index.ts` |
| A request piped to the server gets no answer | Stdin closed before the answer, and the MCP stdio binding stops a server when its input ends | Keep stdin open until you read the answer, as clients do, or run the command from the CLI |
| `npx slipway` prints something unexpected | Slipway is not installed in this folder, so npx fetched an unrelated package called `slipway` | Run `npm install @thenavidm/slipway`, or `npx -p @thenavidm/slipway slipway <command>` |

## Environment variables

Every server reads these, under its own prefix: the app name in capitals, `NOTES` for `notes`, unless `envPrefix` says otherwise. A server's own settings, declared with `settings`, are listed in its help, its `agent-context` and its generated docs, and `install` passes on every one not marked `tuning`.

| Variable | Default | What it does |
|---|---|---|
| `<PREFIX>_READ_ONLY` | `0` | `1` hides and refuses every write |
| `<PREFIX>_ALLOW_DESTRUCTIVE` | `1` | `0` keeps writes and refuses the irreversible ones |
| `<PREFIX>_AUDIT_LOG` | none | File that records every attempted write |
| `<PREFIX>_CONFIRM` | `human` | `model` lets `confirm: true` alone confirm, for an agent with no person to ask |
| `<PREFIX>_CACHE` | `1` | `0` never answers from the local cache |
| `<PREFIX>_DATA_DIR` | the system's data folder | Where the local data file lives |
| `<PREFIX>_TOOLSETS` | `all` | Comma-separated toolsets to turn on. Listed only when some tool has a toolset |
| `<PREFIX>_SURFACE` | `full` | `search` lists three tools that find, describe and run the rest |
| `<PREFIX>_TOOL_TIMEOUT_MS` | none | Give up on any tool after this long |
| `<PREFIX>_HTTP_PORT` | `8787`, or the app's `httpPort` | For `--http` |
| `<PREFIX>_HTTP_HOST` | `127.0.0.1` | For `--http`. Any other address needs a token |
| `<PREFIX>_HTTP_TOKEN` | none | Bearer token required by `--http` |
| `<PREFIX>_HTTP_ALLOWED_ORIGINS` | none | Browser origins beyond localhost that may call `--http`, comma-separated |
| `<PREFIX>_DEBUG` | `0` | `1` prints debug lines on stderr |

## Versions

See [CHANGELOG.md](CHANGELOG.md).

## Servers built on Slipway

| Server | Package | Covers |
| --- | --- | --- |
| [Bluesky](https://github.com/thenavidm/bluesky-mcp-cli) | [`@thenavidm/bluesky-mcp-cli`](https://www.npmjs.com/package/@thenavidm/bluesky-mcp-cli) 2.0.0 | Posting, threads, replies, the timeline, search, feeds, lists, notifications and the social graph |
| [Mastodon](https://github.com/thenavidm/mastodon-mcp-cli) | [`@thenavidm/mastodon-mcp-cli`](https://www.npmjs.com/package/@thenavidm/mastodon-mcp-cli) 2.0.0 | Posting, editing, threads, timelines, search, lists, notifications and following, on any instance |
| [Teachable](https://github.com/thenavidm/teachable-mcp-cli) | [`@thenavidm/teachable-mcp-cli`](https://www.npmjs.com/package/@thenavidm/teachable-mcp-cli) 3.0.0 | Courses, users, enrollments, pricing, coupons and transactions |
| [Threads](https://github.com/thenavidm/threads-mcp-cli) | [`@thenavidm/threads-mcp-cli`](https://www.npmjs.com/package/@thenavidm/threads-mcp-cli) 2.0.0 | Posting, threads, carousels, replies and reply approvals, insights and keyword search |
| [ThriveCart](https://github.com/thenavidm/thrivecart-mcp-cli) | [`@thenavidm/thrivecart-mcp-cli`](https://www.npmjs.com/package/@thenavidm/thrivecart-mcp-cli) 3.0.0 | Products and pricing, transactions and revenue, customers, subscriptions and affiliates, across several carts |

Each server was measured against its previous release before it moved: startup, what a client receives, CLI exit codes, and tokens in Claude Code and Codex. Its README has the numbers.

## 15. FAQ ❓

<details>
<summary><b>What is an MCP server, and why ship a CLI next to it?</b></summary>

An MCP server is how an AI app such as Claude Code, Codex or Claude Desktop reaches a service: it lists tools, and the app calls them for you. A CLI reaches the same service from a terminal, a script or an agent that runs shell commands, and costs nothing until a command runs. Shipping both lets each person and each agent use the one that fits where they are.

</details>

<details>
<summary><b>Why would the two surfaces drift without a framework?</b></summary>

Because they are usually written twice. A flag gets added to one and not the other, a confirmation is checked in one path and forgotten in the other, an error is worded differently. Slipway generates both surfaces from one tool list and sends every call through one function, so a rule added once holds on both.

</details>

<details>
<summary><b>Which MCP clients does it work with?</b></summary>

Any client that speaks MCP over stdio or Streamable HTTP. Slipway uses the official MCP TypeScript SDK v2, which serves clients on the 2025 protocol and on the 2026-07-28 revision from the same server.

</details>

<details>
<summary><b>Does it work with Codex?</b></summary>

Yes, and `<cli> install codex` adds it. Codex launches stdio servers, reads the server's instructions, and asks before tools that are not marked read-only, so Slipway's accurate read marks matter. For an irreversible call it also shows Slipway's approval form, because Codex can be told to remember an approval and the form cannot. `slipway check` warns when the first 512 characters of the instructions never say what the server is, since that is the part Codex leans on.

</details>

<details>
<summary><b>Can a model confirm a destructive call by itself?</b></summary>

No, wherever the client can ask a person. Claude Code shows its own approval prompt on every call to a confirmed tool, and other clients that support elicitation show Slipway's approval form, whatever the model passed. Only a client that can do neither falls back to `confirm: true`. Approvals are signed, bound to the exact call and work once, so a client cannot invent or reuse one either.

</details>

<details>
<summary><b>How do I run an agent with no person watching?</b></summary>

Set `<PREFIX>_CONFIRM=model` for that run, so the model's `confirm: true` confirms and nobody is asked. Without it, Claude Code run with `-p` refuses a tool that needs a person, and Codex run with `exec` declines the approval form. Add `<PREFIX>_READ_ONLY=1` if the agent should only read.

</details>

<details>
<summary><b>What happens when a tool takes longer than the client waits?</b></summary>

Make it a job. The call waits up to `wait_seconds`, then returns the job with a `check` that names the status tool to call next, so the model keeps going instead of seeing a timeout. In a terminal, `--wait` waits to the end.

</details>

<details>
<summary><b>Is the cache safe with more than one account?</b></summary>

Yes. Cached results and synced records are stored per account, from a hash of the credentials or the app's own `dataScope`, and are only ever read back for that account. Any write clears that account's cached results, and credentials are masked before anything is stored.

</details>

<details>
<summary><b>Where is local data kept, and how do I delete it?</b></summary>

In one SQLite file under `<PREFIX>_DATA_DIR`, or the system's data folder: `~/Library/Application Support/slipway/<name>` on macOS, `~/.local/share/slipway/<name>` on Linux, `%LOCALAPPDATA%\slipway\<name>` on Windows. `<cli> data` shows the path, and `<cli> data clear` deletes this account's copy.

</details>

<details>
<summary><b>What does --agent change, and why does it never confirm?</b></summary>

It switches on JSON, one-line output, no prompts and no color, the settings an agent wants on every call. It does not confirm writes, because the agent setting that flag is the caller a confirmation exists to stop. A destructive command runs only when `--confirm` is passed on the call itself.

</details>

<details>
<summary><b>Does it work with tools generated from an OpenAPI document?</b></summary>

Yes. `fromOpenAPI(document, { execute })` turns every operation into a tool, with its risk, toolsets and a hash pin, and `httpExecutor()` calls the API. For one operation from a contract, wrap its JSON Schema with `jsonSchema({...})`.

</details>

<details>
<summary><b>How do I stop a large server from flooding a model's context?</b></summary>

Tag tools into toolsets and let `<PREFIX>_TOOLSETS` turn on only the ones a person needs, or set `<PREFIX>_SURFACE=search` to replace the list with three tools that find, describe and run the rest. `slipway check` also warns when one tool's schema is large or repeats its own definitions.

</details>

<details>
<summary><b>What happens when nothing is configured?</b></summary>

The server still starts and lists its tools, so a client shows them instead of a failed server. A call that needs an account fails with exit code 10 and a hint, and `doctor` says what is missing. `slipway check --bin` tests exactly this before a release.

</details>

<details>
<summary><b>How are credentials kept out of results?</b></summary>

An app returns its credentials from `secrets`, and Slipway masks those values in every result, error, `doctor` report and dry-run preview, on both surfaces. Any field named like a credential, such as `authorization`, `password` or `api_key`, is masked whatever its value.

</details>

<details>
<summary><b>Can I use Valibot or ArkType instead of Zod?</b></summary>

Yes. Any schema that implements Standard Schema with JSON Schema conversion works as `input` or `output`. Slipway re-exports Zod so an app has one copy of it.

</details>

<details>
<summary><b>How do I return images or files?</b></summary>

Return `content([image(bytes, "image/png")], data)`. `audio()`, `file()` and `resourceLink()` cover the other kinds. The parts go to the client as they are, the optional `data` goes out as structured content, and the CLI describes binary parts instead of printing them.

</details>

<details>
<summary><b>Do I need an output schema?</b></summary>

No. Without one, an object result goes out as compact JSON text, which every client reads. Declare `output` when you want the result validated before it leaves the server, its shape advertised, and a typed `structuredContent` copy sent for clients that use data without parsing text. Codex reads that copy in place of the text, so a schema is worth declaring when something uses the shape.

</details>

<details>
<summary><b>How do I test a server without calling the real API?</b></summary>

Build the app with a context that returns a fake client, then use `connect` for the MCP surface and `cli` for the terminal, both from `@thenavidm/slipway/testing`. They run the real server and the real CLI in memory, so a test covers the guard, the schemas and the exit codes along with your handler.

</details>

<details>
<summary><b>What does slipway check catch that unit tests miss?</b></summary>

The failures users meet first: a schema a client rejects, an example that no longer matches its tool, a README command that does not exist, a difference between what MCP clients and the CLI receive, and a built server that exits when nothing is configured. Unit tests run your handlers; `slipway check` runs what you ship.

</details>

<details>
<summary><b>Can I run a server over HTTP?</b></summary>

Yes, with `<mcp> --http`. It binds `127.0.0.1` by default, checks the Host header, and refuses any other address unless `<PREFIX>_HTTP_TOKEN` is set, so a server that acts with your account is never open to the network by accident.

</details>

<details>
<summary><b>How do I move an existing server onto Slipway?</b></summary>

Keep your tool modules and API client. Wrap each tool with `defineTool`, or `jsonSchema` for contract tools, build the app in `app.ts`, and delete the hand-written server, CLI and guard files. Two servers moved this way kept every tool name, title, description and annotation unchanged, and all of their existing tests passed.

</details>

<details>
<summary><b>Which Node.js versions does it support?</b></summary>

Node.js 22 and later, the oldest release line that is still maintained. Local data needs 22.13 or later, for the SQLite built into Node.js.

</details>

<details>
<summary><b>Does install write my API key into a config file?</b></summary>

Not unless you ask. Each client gets a reference instead: Codex forwards the variable, Cursor and Gemini CLI read it from their environment, and VS Code asks for it once and stores it securely. Claude Desktop cannot read a shell's environment, so it gets the key only with `--copy-env`, and the file is then made readable by you only.

</details>

<details>
<summary><b>Is it free to use?</b></summary>

Yes, under the Apache 2.0 license: use it, change it and ship servers built on it, commercial ones included.

</details>

<details>
<summary><b>Why is it called Slipway?</b></summary>

A slipway is the ramp a ship is built on and launched from. That is the job here: build a tool once, then launch it to every client and every terminal from the same place.

</details>

## Questions

Run into a problem or have a question? [Open an issue](https://github.com/thenavidm/slipway/issues) and I will help.

## About the author

Navid Moazzez is a leading AI business strategist, and the host of the AI Creator Summit, watched by 100,000+ creators. He helps creators and founders master AI and build their own AI Operating System (AI OS) to automate their business and life. He creates useful free tools, MCP servers and CLIs that creators and founders can use in their own workflows.

**Links**

- Personal website: [navid.me](https://navid.me?utm_source=github&utm_medium=referral&utm_campaign=slipway&utm_content=readme)
- Link in bio: [navid.bio](https://navid.bio)
- Navid Media: [navid.media](https://navid.media?utm_source=github&utm_medium=referral&utm_campaign=slipway&utm_content=readme)
- YouTube: [@thenavidm](https://youtube.com/@thenavidm?sub_confirmation=1) and [@thenavidai](https://youtube.com/@thenavidai?sub_confirmation=1)
- X: [@thenavidm](https://x.com/thenavidm)
- Instagram: [@thenavidm](https://instagram.com/thenavidm)
- LinkedIn: [thenavidm](https://linkedin.com/in/thenavidm)

## Dependencies

| Library | License | What it does |
|---|---|---|
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) (`@modelcontextprotocol/server`) | Apache-2.0 | The MCP server, transports, protocol eras, elicitation and JSON Schema validation |
| [Zod](https://github.com/colinhacks/zod) | MIT | Tool schemas and validation |
| [Ajv](https://github.com/ajv-validator/ajv), optional, development only | MIT | JSON Schema 2020-12 checks in `slipway check` |
| [yaml](https://github.com/eemeli/yaml), optional, development only | ISC | Reading YAML documents in `slipway openapi` |

## License

[Apache 2.0](./LICENSE). Free to use, modify, and share.

---

© 2026 [Navid Media](https://navid.media?utm_source=github&utm_medium=referral&utm_campaign=slipway&utm_content=readme). Made with ❤️ by [Navid Moazzez](https://navid.me?utm_source=github&utm_medium=referral&utm_campaign=slipway&utm_content=readme).
