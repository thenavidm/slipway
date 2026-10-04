# Security

Slipway is a library. It has no hosted service, no account and no telemetry. A server built on it runs on the machine of whoever installs it, with the credentials they give it.

## What it protects

- **Credentials in output.** Values an app registers as secrets, and any field named like a credential (`authorization`, `password`, `api_key`, `token` and similar), are masked in every result, error, `doctor` report and `--dry-run` preview, on both surfaces.
- **Irreversible actions.** Tools marked destructive refuse to run without an explicit confirmation on the call itself. No flag, setting or agent mode grants it. `<PREFIX>_READ_ONLY=1` removes every write.
- **Approvals.** Over MCP a person approves irreversible calls wherever the client can ask one. An approval form's answer counts only next to state Slipway signed with a per-process key when it asked, naming the exact tool and arguments, valid for ten minutes and usable once. A client cannot approve a call nobody was asked about, replay an approval, or move it to other arguments.
- **Local data.** The cache and synced records live in one SQLite file in a folder readable only by its owner, with the file and its journals readable only by their owner too. Credentials are masked before anything is written, and data is kept apart per account. `data sql` runs on a read-only connection.
- **Client configuration.** `install` writes credentials into a client's file only with `--copy-env`, only for Claude Desktop, and then makes the file readable only by its owner. Every other client gets a reference to the variable. An existing file is backed up before it changes.
- **Generated tools.** `fromOpenAPI` can pin a document by hash and refuses to build from one that changed. `httpExecutor` refuses to send credentials over plain HTTP to another machine.
- **The HTTP transport.** It binds `127.0.0.1` by default and rejects requests whose Host header is not a loopback name, so a web page cannot reach it through a domain that resolves to localhost. It refuses to listen on any other address without a bearer token.
- **Files it writes.** `--out` and the audit log create files readable only by their owner, and `--out` never replaces an existing file.
- **Background jobs.** A job's id is random, so one caller cannot read another's job by guessing, and at most 100 run at once.

## What it does not do

It does not sandbox the tools an app defines. A handler runs with the permissions of the process that started it, and reaches whatever its code reaches.

## Untrusted content

Anything a tool returns from a remote service is data, never instructions. Apps built on Slipway should say so in their server instructions, so the model treats fetched text the same way.

## Reporting a vulnerability

[Report it privately](https://github.com/thenavidm/slipway/security/advisories/new).
Please do not open a public issue for a security problem: an issue is visible
to everyone the moment you file it, including whoever would use the bug.

Good-faith research is welcome. If you are testing within these lines and stay
off other people's data and systems, you will not hear from me about anything
but the bug.
