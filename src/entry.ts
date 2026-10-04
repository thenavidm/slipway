/**
 * One entry point, two binaries.
 *
 * `<name>-mcp` with no arguments is an MCP client starting a stdio server, and
 * must stay silent on stdout. `<name>-cli` with no arguments is a person who
 * wants to know what they can type. Any argument on either binary is a CLI
 * command, so a typo is reported instead of starting a server that sits
 * waiting on stdin and looks like a hang.
 */

import { stderrLogger, type App } from "./app.js";
import { SlipwayError } from "./errors.js";

export async function main(app: App, argv: string[], invokedAs: string): Promise<void> {
  const asCli = invokedAs.startsWith(app.bins.cli);

  if (!asCli && argv.includes("--http")) {
    const { httpOptions, serveHttpApp } = await import("./serve.js");
    try {
      const served = await serveHttpApp(app, process.env, httpOptions(app, process.env, argv));
      const stop = () => void served.close().finally(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    } catch (error) {
      stderrLogger(app.envPrefix, process.env).error((error as Error).message);
      process.exitCode = error instanceof SlipwayError ? error.exitCode : 1;
    }
    return;
  }

  if (!asCli && argv.length === 0) {
    const { serveStdioApp } = await import("./serve.js");
    await serveStdioApp(app, process.env);
    return;
  }

  process.exitCode = await app.runCli(argv, { bin: asCli ? app.bins.cli : app.bins.mcp });
}
