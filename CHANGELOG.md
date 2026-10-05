# Changelog

What changed in Slipway, newest first.

## 0.1.19, 2026-10-05: what Lemon Squeezy needed

- **`which` answers with a command's help when one fits well ahead of the rest.** An agent asked `which` for the command and then read that command's `--help`, and each request carries the whole conversation. On Lemon Squeezy, `which cancel subscription` and then `cancel-subscription --help` cost Codex a median of 83,076 input tokens, where its 2.x CLI guessed the command's name and read its help in two requests for 61,541. When the first answer scores at least half again as much as the second, its help now follows the list, and three runs took 61,903, 61,913 and 61,908 in two requests. A close second gets the list alone: Gumroad's `which refund` fits refunding a sale and its refund policy alike, and the help shown would be a guess between them.

## 0.1.18, 2026-10-05: what Wistia and Testimonial.to needed

- **A command's help never lists `--confirm` as the only required flag.** Wistia's import takes its URL as a flag or inside `--payload`, so no flag is required, and its help showed a Required section holding only `--confirm`. That reads as if nothing else were needed: every Codex run then read the command's schema as well, and finding the command and its flags cost a median of 105,140 input tokens, where Wistia's own 2.x CLI cost 86,365. Alone, `--confirm` now closes the options, where 2.x listed it, and the usage line still ends with it; two runs then took 83,069 and 82,817.
- **The general help leaves the flags to each command.** Each command's `--help` lists the flags it can use, `--agent` among them, so the general help's line of them repeated what an agent reads one step later, after carrying that line through every step in between. Without it the general help is 35 tokens shorter on every server: Testimonial.to's goes from 324 to 289.

## 0.1.17, 2026-10-05: what Google Photos needed

- **`which` reads an argument by its own words, not through a synonym.** Since 0.1.14 a tool's argument names count toward finding it, and a synonym reached them too. Google Photos says "photos" means media, so `get_media_item`, which takes a `media_item_id`, drew level with the photo picker for "let me choose photos" and was listed first. An argument now counts only for the words it is made of, so the picker is first again. Buffer's "schedule a post to a channel" still reads `channelId` and `schedulingType`, and the first answer to every task measured on the other servers is unchanged.

## 0.1.16, 2026-10-05: what Flodesk needed

- **`which` says a title once.** Each answer line printed a tool's title and then the first sentence of its description, and many descriptions open with the title itself: 24 of Flodesk's 32 tools, 10 of Firefly's 14, and nearly every tool on Beehiiv, Calendly and Circle. Where the sentence opens with the title's words, the line now prints the sentence alone. Flodesk's answer to `which add a subscriber to a segment` goes from 52 tokens to 36 and Firefly's to `which image model 5` from 90 to 77, and an agent carries that answer through each step after it. A description that adds something new still follows its title.

## 0.1.15, 2026-10-05: what Adobe Firefly needed

- **The general help counts the tuning settings instead of naming them.** An agent reads `--help` first and carries it through every later step, so its length is paid again on each one. Firefly's help named 14 settings on its last line, and with only 14 commands its whole command list was shorter; its Codex CLI task cost 370 more input tokens on Slipway than on its own 2.x CLI. The line now says how many more settings there are and that `agent-context` describes each, the `--http` settings join that count, and the safety switches and the settings an app marks as setup are still named. Every server's help is shorter by the names it had on that line.

## 0.1.14, 2026-10-05: what Buffer needed

- **`which` and the search surface read what a tool takes.** Argument names count for a little less than the title and more than the description, and camelCase is split, so `channelId` reads as "channel" and `createPost` as "create post". Buffer's "schedule a post to a channel" never listed `create-post`, whose description says neither word but whose `channelId` and `schedulingType` say both; a Codex run that asked `which` then read the whole command list as well.

## 0.1.13, 2026-10-05: what Beehiiv needed

- **`jsonSchema(schema, { shareRepeats: true })` writes each repeated part of a contract schema once.** A schema generated from an API contract often spells one definition out everywhere it is used. Beehiiv's post body repeats its block styling in each of 33 block types and carries the body twice, as its own fields and as `payload`, so its create-post tool advertised 387 KB. With each repeated part under `$defs` and referred to with `$ref`, it is 40 KB, and Beehiiv's 117 tools together go from 1,684 KB to 308 KB. Nothing is lost: each part reads the same once the references are followed, Claude Code and Codex both read fields that appear only under `$defs`, and validation accepts and refuses the same arguments. Definitions take the name of the property or block type they came from, such as `paragraph` or `visual_settings`, and parts under 200 bytes stay inline. The work is linear in the schema's size and happens when the tool is first listed. `shareRepeats()` is exported for a schema built some other way.
- **`slipway check` names that fix wherever it would help.** A schema over the size budget whose shared form is at least a fifth smaller says how big it would be.
- **CLI flags read through `$ref`.** An array whose items were a reference became a repeatable text flag, so a list of objects could not be passed; it is a JSON flag again, and a property that is only a reference takes its type, choices and description from the definition. `slipway check` no longer warns that such a property has no description.
- **`doctor` tells a server that only reads apart.** "Writes: on" read as if it could change something; it now says every tool only reads. A setting doctor cannot read points at `login` for what to set, where it told the person to run the doctor they were running, and the verdict says a setting needs fixing rather than that nothing is configured.

## 0.1.12, 2026-10-05: what the Meta Ad Library needed

- **The write switches appear only where they act.** `<PREFIX>_READ_ONLY` and `<PREFIX>_AUDIT_LOG` are listed in the general help, `agent-context` and the generated settings table only when a tool writes, and `<PREFIX>_ALLOW_DESTRUCTIVE` and `<PREFIX>_CONFIRM` only when a tool can be irreversible, spends money or needs confirming. The Meta Ad Library server only reads, and its help offered to "refuse the irreversible writes"; it is now 40 tokens shorter, 399 against 439. The switches still work if set.

## 0.1.11, 2026-10-05: what WordPress needed

- **Records no longer advertise `propertyNames`.** Zod 4 gives every `z.record` `propertyNames: { type: "string" }`, which every JSON object key already is, and the Zod 3 converters never wrote it. Slipway leaves it out of what clients receive, as it does the safe-integer bounds, and validation still runs on the schema itself. Each one cost 8 tokens; WordPress has nine. An argument that happens to be named `propertyNames` is a name, so it stays.

## 0.1.10, 2026-10-05: what TikTok needed

- **`destructiveOff: "hide"`: a server can take its irreversible tools off the list when they are off.** By default `<PREFIX>_ALLOW_DESTRUCTIVE=0` keeps them listed and refuses each call. With `defaults: { destructiveOff: "hide" }` they leave the MCP tool list and the command list, as read-only mode does with every write, and calling one anyway is refused with the setting to unset. TikTok 1.1 hid its publishing tools this way, and keeps doing so.
- **A shorter general help, for every server.** An agent reads it first and carries it through every later step. Slipway's settings past the two safety switches are named on the "Also" line with the app's tuning settings, the list formats and `--out` and `--timeout` are left to each command's help and `agent-context`, and the command lines say less. On TikTok it went from 530 tokens to 412, which cut Codex's CLI task by about 350 tokens.
- **`hidden: true` keeps a command out of the general help**, such as `auth`, the name an older release used for `login`. It still runs, and `agent-context` still lists it.
- **A refusal no longer doubles a period.** A summary that ends its own sentence, as TikTok's "Publish a video at SELF_ONLY." does, read "About to: Publish a video at SELF_ONLY.." in the refusal and the approval messages.

## 0.1.9, 2026-10-05: what Substack needed

- **A resource can wait for an account.** `listed(env)` leaves a resource out until it returns true. Substack 2.2.3 offered its two resources only once a publication was connected; on Slipway they were always offered, and Claude Code then adds its own two resource tools to every message: 40 tokens in tool search, for reads that could only fail.
- **The general help keeps its columns narrow.** Commands and settings each line up on their own, and an entry longer than 40 characters puts its help on the next line instead of pushing every other row out to its width. Substack's `login [<publication>] [--paste | --playwriter | --playwright]` started every description in the help at column 80, past the edge of a standard terminal; they now start at 34.

## 0.1.8, 2026-10-05: what Midjourney and Substack needed

- **HTTP checks Origin.** A request whose `Origin` is another site is refused unless `<PREFIX>_HTTP_ALLOWED_ORIGINS` lists it, as the MCP transport spec asks: a page in a browser can send a request to a localhost server, and only that header says where it came from. Clients that are not browsers send none and are unaffected. Substack's own server did this before it moved.
- **`spends`: a call that costs money.** A paid generation needs confirming, `<PREFIX>_ALLOW_DESTRUCTIVE=0` refuses it, the CLI marks it `$`, and its refusal says it spends money that cannot be refunded, while clients still see a plain write, because making an image destroys nothing. Midjourney's ten generating tools are this.
- **`flagAliases`: the spellings people already use.** `{ ar: "aspect" }` lets `--ar 16:9` set `aspect` on every command that has it, and help shows the alias beside the flag. `slipway check` fails an alias no input takes.
- **`synonyms`, stopwords and exact names in search.** An app can map the words its users type onto the words its tools use, for `which` and the search surface; a query of filler words finds nothing instead of everything; and a term that is a tool's name, or a synonym pointing at it, wins outright. Midjourney's "make a picture" finds `imagine`, not `vary_image`.
- **`--select` reaches into a result list.** When no path starts at the top and a result holds one list of records, the fields are selected inside it and the rest is kept: `--select id` on `{ count, jobs: [...] }` keeps the count and each job's id.
- **An app command can own a flag Slipway also has.** `flags: ["--out"]` hands `--out` to the command instead of taking it as the global output flag. Midjourney's `capture --out` needs it.
- **`login --help` prints the steps** for an app whose login is printed steps, not the general help.
- **A command's own `--help` page reads as a sentence.** The line written for the command table, such as "capture a session for your publication once", starts with a capital and ends with a period on `login --help` and an app command's `--help`.
- **Every command's `--help` is 10 tokens shorter.** `--select` and `--agent` say what they do in fewer words, and a read says `Risk: read`. Midjourney's `list-jobs --help` had grown 10 tokens on the move and is now the size 1.3.1's was.
- **The unknown-command hint names one binary.** Typed at the MCP binary it said to list commands with `substack-cli` and find one with `substack-mcp which`; both now name the CLI binary.
- **`install` says where settings go, not that they must be set.** Most settings are optional, and the notes no longer read as an order to set every one.

## 0.1.7, 2026-10-05: what Threads and ThriveCart needed, and what Substack and WordPress will

- **`riskFor`: a write whose arguments decide its risk.** Publishing is destructive and saving a draft is a write, from the same tool. `risk` stays the highest a call can be, which is what clients see in annotations and listings; the guard, the approval and the audit log go by the call, and only a destructive call needs confirming. WordPress's post tools need it: 1.1 confirmed publishing and not drafting.
- **`onServe`: work that belongs to a running server.** It runs once the server is answering, over stdio or HTTP, and never for a CLI command, with the context and the server's logger; a throw is logged and the server keeps serving. Threads uses it to warn that a token expires this week, and Substack's queue of scheduled Notes needs it.
- **A tool's own consequence.** `consequence` replaces "is public or cannot be undone" in the refusal and the approval form. ThriveCart's refund said it "is public" on Slipway and now says it "moves money or ends a customer's access and cannot be undone", as its own release did.
- **`which` lists only the close matches.** Results scoring at least half of the best one, and always the top three. On Threads, "publish a post staged earlier" printed ten lines, 1,077 characters, where three carried the answer.
- **`<PREFIX>_TOOLSETS` is listed only when some tool has a toolset.** With none, every tool is always on and the switch does nothing, so help and `agent-context` stop offering it.
- **Tests from the servers that moved.** ThriveCart's cases for `--select` paths that share a head and for a list of choices typed as repeated words now run here, where that code lives.

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
