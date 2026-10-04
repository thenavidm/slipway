/**
 * `data`: the local data file from a terminal.
 *
 *   data                        what is kept, where, and for which account
 *   data sync <command> [flags] copy every page of a list to this machine
 *   data search <words>         search synced records offline
 *   data sql "<select>"         query it with read-only SQL
 *   data clear [<command>]      delete this account's local data
 */

import type { App, CliIO } from "../app.js";
import { EXIT, UsageError } from "../errors.js";
import { syncTool } from "../sync.js";
import { flagsFor, parseToolArgs } from "./flags.js";
import { formatOutput, type Format } from "./output.js";

export type DataOptions = { format: Format; select?: string[]; agent: boolean };

const SUBCOMMANDS = ["status", "sync", "search", "sql", "clear"] as const;

/** The value of `--name value` or `--name=value` in a list of tokens, and the tokens without it. */
function take(tokens: string[], name: string): { value?: string; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === name) {
      value = tokens[++i];
      if (value === undefined) throw new UsageError(`${name} expects a value.`);
    } else if (token.startsWith(`${name}=`)) value = token.slice(name.length + 1);
    else rest.push(token);
  }
  return { value, rest };
}

function print(io: CliIO, value: unknown, options: DataOptions): number {
  io.stdout(formatOutput(value, undefined, { format: options.format === "auto" ? "json" : options.format, select: options.select }));
  return EXIT.ok;
}

export async function runData(app: App, io: CliIO, tokens: string[], options: DataOptions): Promise<number> {
  const [first, ...rest] = tokens;
  const sub = first ?? "status";
  if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new UsageError(`data has no '${sub}'. It takes: ${SUBCOMMANDS.join(", ")}.`, { hint: `Run \`${io.bin} help\` for what each does.` });
  }

  const store = await app.localData(io.env);
  const scope = app.dataScope(await app.context(io.env));

  switch (sub) {
    case "status": {
      const synced = store.synced(scope).map((entry) => ({ ...entry, command: app.find(entry.tool)?.command ?? entry.tool }));
      return print(io, {
        file: store.file,
        account: scope,
        cached_results: store.cacheEntries(scope),
        synced,
        can_sync: app.allTools.filter((tool) => tool.sync).map((tool) => tool.command),
      }, options);
    }

    case "sync": {
      const [command, ...flags] = rest;
      if (!command) throw new UsageError("data sync expects the command to copy: data sync <command>.");
      const tool = app.find(command);
      if (!tool) throw new UsageError(`Unknown command '${command}'.`, { hint: `Run \`${app.bins.cli}\` to list commands.` });
      if (!tool.sync) {
        const lists = app.allTools.filter((candidate) => candidate.sync).map((candidate) => candidate.command);
        throw new UsageError(`${tool.command} is not a list that can be synced.`, { hint: `Lists that can: ${lists.join(", ") || "none"}.` });
      }
      const args = await app.parse(tool, parseToolArgs(flags, flagsFor(tool.jsonSchema), tool.positional));
      const report = await syncTool(app, tool, args, {
        surface: "cli",
        env: io.env,
        ...(io.isTTY && !options.agent ? { onProgress: ({ message }) => io.stderr(`… ${message ?? ""}\n`) } : {}),
      });
      return print(io, report, options);
    }

    case "search": {
      const where = take(rest, "--in");
      const limit = take(where.rest, "--limit");
      const words = limit.rest.filter((token) => !token.startsWith("--")).join(" ");
      if (!words) throw new UsageError("data search expects the words to find: data search <words>.");
      const tool = where.value ? app.find(where.value) : undefined;
      if (where.value && !tool) throw new UsageError(`Unknown command '${where.value}'.`);
      const count = limit.value === undefined ? 20 : Number(limit.value);
      if (!Number.isInteger(count) || count < 1 || count > 100) throw new UsageError(`--limit expects a whole number from 1 to 100, got '${limit.value}'.`);
      const hits = store.search(scope, words, { ...(tool ? { tool: tool.name } : {}), limit: count });
      if (options.format === "auto" && io.isTTY && !options.select?.length) {
        if (!hits.length) {
          io.stdout(`Nothing synced matches '${words}'. Sync a list first: ${io.bin} data sync <command>.\n`);
          return EXIT.ok;
        }
        for (const hit of hits) io.stdout(`${app.find(hit.tool)?.command ?? hit.tool}  ${hit.id}  ${hit.snippet.replace(/\s+/g, " ")}\n`);
        return EXIT.ok;
      }
      return print(io, { query: words, count: hits.length, results: hits }, options);
    }

    case "sql": {
      const sql = rest.join(" ").trim();
      if (!sql) throw new UsageError(`data sql expects one SELECT statement: ${io.bin} data sql "select tool, count(*) from records group by tool"`);
      const rows = store.query(sql);
      return print(io, rows, options);
    }

    case "clear": {
      const cacheOnly = rest.includes("--cache");
      const command = rest.find((token) => !token.startsWith("--"));
      const tool = command ? app.find(command) : undefined;
      if (command && !tool) throw new UsageError(`Unknown command '${command}'.`);
      const cleared = {
        cached_results: tool ? 0 : store.cacheClear(scope),
        records: cacheOnly ? 0 : store.clearRecords(scope, tool?.name),
      };
      return print(io, cleared, options);
    }
  }
  return EXIT.ok;
}
