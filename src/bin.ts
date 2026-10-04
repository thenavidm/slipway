#!/usr/bin/env node
/**
 * The `slipway` command, for people building on Slipway.
 *
 *   slipway check [module]    the release gate: schemas, parity, docs, startup
 *   slipway docs [module]     the command and argument reference, as Markdown
 *   slipway inspect [module]  what an MCP client receives
 *   slipway openapi <doc>     the tools an OpenAPI document becomes, and its pin
 *
 * `module` is the built file that exports the app, `dist/app.js` by default.
 * It must only export the app: the file that calls `app.main()` would start a
 * server the moment it was imported.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { App } from "./app.js";
import { checkApp } from "./check.js";
import { SLIPWAY_VERSION } from "./cli/context.js";
import { renderDocs } from "./docs.js";
import { fromOpenAPI, openapiHash, readOperations } from "./openapi.js";
import { connectInMemory } from "./rpc.js";

const HELP = `slipway ${SLIPWAY_VERSION}

  slipway check [module] [--bin <entry>] [--docs a.md,b.md] [--json] [--strict]
      Check an app before release: names, descriptions, schema validity and
      size, examples, MCP and CLI parity, the commands your docs mention, and
      (with --bin) that the built server starts with nothing configured.

  slipway docs [module]
      Print the command and argument reference as Markdown.

  slipway inspect [module] [--json]
      List the tools exactly as an MCP client receives them.

  slipway openapi <file|url> [--json]
      Show the tools an OpenAPI 3 document becomes: names, risk, toolsets,
      what is skipped and why, and the sha256 to pin it with.

  module defaults to dist/app.js, a file that exports the app and does not start it.
`;

function option(argv: string[], name: string): string | undefined {
  const at = argv.findIndex((token) => token === name || token.startsWith(`${name}=`));
  if (at === -1) return undefined;
  return argv[at]!.includes("=") ? argv[at]!.split("=").slice(1).join("=") : argv[at + 1];
}

async function loadApp(path: string | undefined): Promise<App> {
  const file = resolve(path ?? "dist/app.js");
  if (!existsSync(file)) {
    throw new Error(`${file} does not exist. Build first, or pass the module that exports your app.`);
  }
  const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  const app = [module.default, module.app, ...Object.values(module)].find(
    (value): value is App => (value as App | undefined)?.kind === "slipway.app",
  );
  if (!app) throw new Error(`${file} exports no Slipway app. Export the value slipway({...}) returns.`);
  return app;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const positional = rest.filter((token, i) => !token.startsWith("--") && !["--bin", "--docs"].includes(rest[i - 1] ?? ""))[0];

  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    process.stdout.write(`${SLIPWAY_VERSION}\n`);
    return 0;
  }

  if (command === "openapi") {
    if (!positional) throw new Error("openapi expects a document: slipway openapi openapi.json");
    return openapiPreview(positional, rest.includes("--json"));
  }

  const app = await loadApp(positional);

  if (command === "docs") {
    process.stdout.write(renderDocs(app, process.env));
    return 0;
  }

  if (command === "inspect") {
    const client = await connectInMemory(app, process.env);
    const tools = await client.listTools();
    await client.close();
    if (rest.includes("--json")) process.stdout.write(`${JSON.stringify({ initialize: client.initialize, tools }, null, 2)}\n`);
    else {
      process.stdout.write(`${client.initialize.serverInfo.name} ${client.initialize.serverInfo.version}, protocol ${client.initialize.protocolVersion}, ${tools.length} tools\n\n`);
      for (const tool of tools) {
        const a = tool.annotations ?? {};
        const mark = a.readOnlyHint ? " " : a.destructiveHint ? "!" : "*";
        process.stdout.write(`  ${mark} ${tool.name}  ${Math.round(JSON.stringify(tool).length / 102.4) / 10} KB${tool.outputSchema ? "  typed" : ""}\n`);
      }
    }
    return 0;
  }

  if (command === "check") {
    const docs = option(rest, "--docs")?.split(",").filter(Boolean);
    const bin = option(rest, "--bin");
    const packageJson = resolve("package.json");
    const report = await checkApp(app, {
      env: process.env,
      ...(docs ? { docs } : {}),
      ...(bin ? { bin: resolve(bin) } : {}),
      ...(existsSync(packageJson) ? { packageJson } : {}),
    });
    const strict = rest.includes("--strict");
    const failed = report.errors > 0 || (strict && report.warnings > 0);
    if (rest.includes("--json")) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return failed ? 1 : 0;
    }
    const s = report.stats;
    process.stdout.write(
      `\n${app.title} ${app.version}: ${s.tools === s.allTools ? `${s.tools} tools` : `${s.tools} of ${s.allTools} tools on`} (${s.reads} read, ${s.writes} write, ${s.irreversible} irreversible, ${s.confirmed} confirmed, ${s.typedOutput} typed)\n` +
        `Schemas: ${Math.round(s.schemaBytes / 1024)} KB across all ${s.allTools} tools${s.largestTool ? `, largest ${s.largestTool.name} at ${Math.round(s.largestTool.bytes / 1024)} KB` : ""}` +
        `${s.startupMs !== undefined ? `. Answered initialize in ${s.startupMs} ms with nothing configured` : ""}.\n\n`,
    );
    for (const finding of report.findings) {
      process.stdout.write(`  ${finding.level === "error" ? "✗" : "!"} [${finding.check}]${finding.tool ? ` ${finding.tool}:` : ""} ${finding.message}\n`);
    }
    process.stdout.write(`\n${report.errors} errors, ${report.warnings} warnings. ${failed ? "Not ready." : "Ready."}\n`);
    return failed ? 1 : 0;
  }

  process.stderr.write(`Unknown command '${command}'.\n\n${HELP}`);
  return 2;
}

/** Read a document from a file or a URL, as JSON, or as YAML when the yaml package is installed. */
async function readDocument(source: string): Promise<unknown> {
  const text = /^https?:\/\//.test(source)
    ? await fetch(source).then((response) => {
        if (!response.ok) throw new Error(`${source} answered ${response.status}.`);
        return response.text();
      })
    : readFileSync(resolve(source), "utf8");
  if (/^\s*[{[]/.test(text)) return JSON.parse(text);
  try {
    const yaml = (await import("yaml" as string)) as { parse(text: string): unknown };
    return yaml.parse(text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ERR_MODULE_NOT_FOUND") throw new Error("This document is YAML. Install the yaml package (npm install --save-dev yaml), or convert it to JSON.");
    throw error;
  }
}

async function openapiPreview(source: string, json: boolean): Promise<number> {
  const document = await readDocument(source);
  const { operations, skipped } = readOperations(document);
  const tools = fromOpenAPI(document, { execute: () => undefined });
  const sha256 = openapiHash(document);
  const rows = tools.map((tool, i) => ({
    tool: tool.name,
    operation: `${operations[i]!.method} ${operations[i]!.path}`,
    risk: tool.risk,
    toolsets: tool.tags,
    schema_kb: Math.round(JSON.stringify(tool.jsonSchema).length / 102.4) / 10,
  }));
  if (json) {
    process.stdout.write(`${JSON.stringify({ tools: rows, skipped, pin: { sha256 } }, null, 2)}\n`);
    return 0;
  }
  const info = (document as { info?: { title?: string; version?: string } }).info;
  const width = Math.max(4, ...rows.map((row) => row.tool.length)) + 2;
  process.stdout.write(`\n${info?.title ?? "API"} ${info?.version ?? ""}: ${tools.length} tools from ${operations.length + skipped.length} operations\n\n`);
  for (const row of rows) {
    const mark = row.risk === "read" ? " " : row.risk === "destructive" ? "!" : "*";
    process.stdout.write(`  ${mark} ${row.tool.padEnd(width)}${row.operation}${row.toolsets.length ? `  [${row.toolsets.join(", ")}]` : ""}${row.schema_kb > 16 ? `  ${row.schema_kb} KB` : ""}\n`);
  }
  if (skipped.length) {
    process.stdout.write(`\nSkipped:\n`);
    for (const item of skipped) process.stdout.write(`  ${item.method} ${item.path}: ${item.reason}\n`);
  }
  const large = rows.filter((row) => row.schema_kb > 16).length;
  if (large) process.stdout.write(`\n${large} ${large === 1 ? "schema is" : "schemas are"} over 16 KB, which a model pays for each time it loads the tool. Leave such operations out with include, or offer the tools through ${"<PREFIX>"}_SURFACE=search.\n`);
  process.stdout.write(`\n  * writes    ! public or irreversible\n\nPin this document in fromOpenAPI:\n  pin: { sha256: "${sha256}" }\n\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`slipway: ${(error as Error).message}\n`);
    process.exitCode = 1;
  },
);
