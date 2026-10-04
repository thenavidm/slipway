/**
 * Helpers for testing an app the way its users reach it.
 *
 *     import { connect, cli } from "@thenavidm/slipway/testing";
 *
 *     const mcp = await connect(app, { env });
 *     const result = await mcp.callTool("get_profile", { actor: "alice" });
 *
 *     const { code, stdout } = await cli(app, ["get-profile", "alice", "--json"], { env });
 */

import type { App } from "./app.js";
import { connectInMemory, type ConnectOptions, type RpcClient } from "./rpc.js";

export { checkApp, type CheckOptions, type CheckReport, type Finding } from "./check.js";
export type { ConnectOptions, ElicitAnswer, ElicitRequest, ListedTool, RpcClient } from "./rpc.js";

/**
 * An MCP client connected to the app's real server, in memory.
 *
 *     // A person who approves every form the server shows them:
 *     const mcp = await connect(app, { elicit: () => ({ action: "accept", content: { approve: true } }) });
 */
export function connect(app: App, options: ConnectOptions & { env?: NodeJS.ProcessEnv } = {}): Promise<RpcClient> {
  const { env, ...rest } = options;
  return connectInMemory(app, env ?? {}, rest);
}

export type CliRun = { code: number; stdout: string; stderr: string };

/** Run the CLI with captured output. Nothing reaches the real terminal. */
export async function cli(
  app: App,
  argv: string[],
  options: { env?: NodeJS.ProcessEnv; stdin?: string; isTTY?: boolean; cwd?: string } = {},
): Promise<CliRun> {
  let stdout = "";
  let stderr = "";
  const code = await app.runCli(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdin: async () => options.stdin ?? "",
    env: options.env ?? {},
    isTTY: options.isTTY ?? false,
    bin: app.bins.cli,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  return { code, stdout, stderr };
}
