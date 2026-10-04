/**
 * The MCP surface.
 *
 * Every tool is registered from its definition with the annotations its risk
 * implies, so a client that auto-approves reads or prompts on writes gets an
 * honest answer from every tool, not only the ones someone remembered to mark.
 */

import { McpServer, type CallToolResult, type ServerContext, type ToolAnnotations } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { App, InvokeOptions, PromptDefinition, ResourceDefinition } from "./app.js";
import { clientView, confirmRoute, personApproval, verifyApprovalState } from "./confirm.js";
import { toSlipwayError, UsageError } from "./errors.js";
import type { Policy } from "./policy.js";
import { errorResult, isPlainObject, toCallToolResult } from "./result.js";
import { outputJsonSchema } from "./schema.js";
import { firstSentence, searchTools } from "./search.js";
import type { Tool } from "./tool.js";

/** Claude Code shows a person a permission prompt on every call to a tool carrying this, in any mode. */
export const REQUIRES_USER_INTERACTION = "anthropic/requiresUserInteraction";
/** Claude Code raises its result-size limit for a tool carrying this. */
export const MAX_RESULT_SIZE_CHARS = "anthropic/maxResultSizeChars";

export function annotationsFor(tool: Tool): ToolAnnotations {
  return {
    title: tool.title,
    readOnlyHint: tool.risk === "read",
    destructiveHint: tool.risk === "destructive",
    idempotentHint: tool.idempotent,
    openWorldHint: tool.openWorld,
  };
}

export function metaFor(tool: Tool, policy: Policy): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = { ...(tool.meta ?? {}) };
  if (tool.requireConfirm && policy.confirm === "human") meta[REQUIRES_USER_INTERACTION] = true;
  if (tool.maxResultChars) meta[MAX_RESULT_SIZE_CHARS] = tool.maxResultChars;
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/** The `_meta` key that marks a result served from the local cache, with its age. */
export const CACHE_META = "slipway/cache";

function withCacheNote(result: CallToolResult, cached: { ageSeconds: number } | undefined): CallToolResult {
  return cached ? { ...result, _meta: { ...(result._meta ?? {}), [CACHE_META]: { age_seconds: cached.ageSeconds } } } : result;
}

type Progress = (update: { progress: number; total?: number; message?: string }) => Promise<void>;

/** Progress goes to a client only when its request asked for it with a progress token. */
function progressFor(ctx: ServerContext): Progress | undefined {
  const token = ctx.mcpReq._meta?.progressToken;
  if (token === undefined) return undefined;
  return async ({ progress, total, message }) => {
    await ctx.mcpReq.notify({
      method: "notifications/progress",
      params: { progressToken: token, progress, ...(total === undefined ? {} : { total }), ...(message ? { message } : {}) },
    });
  };
}

export function buildServer<Ctx>(app: App<Ctx>, env: NodeJS.ProcessEnv): McpServer {
  const policy = app.policy(env);
  const server = new McpServer(
    {
      name: app.name,
      title: app.title,
      version: app.version,
      ...(app.definition.icons ? { icons: app.definition.icons } : {}),
    },
    {
      ...(app.instructions ? { instructions: app.instructions } : {}),
      // Approval forms carry signed state; anything Slipway did not sign is refused before a handler sees it.
      requestState: { verify: verifyApprovalState },
    },
  );

  if (policy.surface === "search") registerSearchSurface(server, app, env, policy);
  else for (const tool of app.tools(env)) registerTool(server, app, tool, env, policy);

  for (const resource of app.definition.resources ?? []) registerResource(server, app, resource, env);
  for (const prompt of app.definition.prompts ?? []) registerPrompt(server, app, prompt, env);
  return server;
}

// The SDK derives its callback type from the schema generic, which a tool list
// of mixed schemas cannot satisfy statically. The cast lives here, once, and the
// type safety that matters is inside each defineTool call.
type LooseRegister = (name: string, config: Record<string, unknown>, cb: (args: any, ctx: ServerContext) => Promise<unknown>) => unknown;

/**
 * Confirm a call the way this client allows, before it runs.
 *
 * Returns the approval form to send while a person has not answered, or the
 * options `run` needs once the call may go ahead. `listedForPerson` is true
 * when the tool's own `tools/list` entry asked the client for a person, which
 * is what makes Claude Code prompt for it.
 */
async function confirmFirst<Ctx>(
  server: McpServer,
  app: App<Ctx>,
  tool: Tool<Ctx>,
  args: Record<string, unknown>,
  ctx: ServerContext,
  env: NodeJS.ProcessEnv,
  policy: Policy,
  listedForPerson: boolean,
): Promise<{ ask: unknown } | { approvedBy?: InvokeOptions["approvedBy"] }> {
  if (!tool.requireConfirm) return {};
  const route = confirmRoute(policy.confirm, clientView(server, ctx), listedForPerson);
  if (route === "client") return { approvedBy: "client" };
  if (route === "flag") return {};
  const ask = await personApproval(app, tool, args, ctx, env);
  return ask ? { ask } : { approvedBy: "person" };
}

function registerTool<Ctx>(server: McpServer, app: App<Ctx>, tool: Tool<Ctx>, env: NodeJS.ProcessEnv, policy: Policy): void {
  const meta = metaFor(tool, policy);
  (server.registerTool.bind(server) as unknown as LooseRegister)(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.schema,
      ...(tool.output ? { outputSchema: tool.output } : {}),
      annotations: annotationsFor(tool),
      ...(tool.icons ? { icons: tool.icons } : {}),
      ...(meta ? { _meta: meta } : {}),
    },
    async (args, ctx) => {
      try {
        const raw = (args ?? {}) as Record<string, unknown>;
        const confirmed = await confirmFirst(server, app, tool, raw, ctx, env, policy, meta?.[REQUIRES_USER_INTERACTION] === true);
        if ("ask" in confirmed) return confirmed.ask;
        let cached: { ageSeconds: number } | undefined;
        const value = await app.run(tool, raw, {
          surface: "mcp",
          approvedBy: confirmed.approvedBy,
          signal: ctx.mcpReq.signal,
          env,
          onProgress: progressFor(ctx),
          onCache: (hit) => (cached = hit),
        });
        return withCacheNote(toCallToolResult(tool, value, app.secrets), cached);
      } catch (error) {
        return errorResult(toSlipwayError(error), app.secrets);
      }
    },
  );
}

/**
 * Three tools that stand in for a large catalog.
 *
 * A client that loads every tool definition up front pays for all of them on
 * every message. With `<PREFIX>_SURFACE=search` the model finds a tool by what
 * it does, reads that one schema, and calls it through the same guard.
 */
function registerSearchSurface<Ctx>(server: McpServer, app: App<Ctx>, env: NodeJS.ProcessEnv, policy: Policy): void {
  const register = server.registerTool.bind(server) as unknown as LooseRegister;
  const visible = () => app.tools(env);

  register(
    "search_tools",
    {
      title: "Find a tool",
      description: `Search ${app.title}'s tools by what they do. Returns names, titles and risk. Call describe_tool on a result for its arguments, then call_tool to run it.`,
      inputSchema: z.object({
        query: z.string().min(1).describe("What you want to do, in plain words: 'schedule a post', 'list subscribers'."),
        limit: z.number().int().min(1).max(50).optional().describe("How many results, 1-50. Defaults to 10."),
      }),
      annotations: { title: "Find a tool", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const matches = searchTools(visible(), query, limit ?? 10).map(({ tool }) => ({
        name: tool.name,
        title: tool.title,
        risk: tool.risk,
        requires_confirm: tool.requireConfirm,
        summary: firstSentence(tool.description),
      }));
      const data = { query, count: matches.length, tools: matches };
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    },
  );

  register(
    "describe_tool",
    {
      title: "Describe a tool",
      description: "The full description, argument schema and examples of one tool found with search_tools.",
      inputSchema: z.object({ name: z.string().min(1).describe("The tool name from search_tools.") }),
      annotations: { title: "Describe a tool", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name }) => {
      const tool = visible().find((candidate) => candidate.name === name);
      if (!tool) return errorResult(new UsageError(`No tool named '${name}'. Use search_tools to find one.`), app.secrets);
      const data = {
        name: tool.name,
        title: tool.title,
        description: tool.description,
        risk: tool.risk,
        requires_confirm: tool.requireConfirm,
        input_schema: tool.jsonSchema,
        ...(tool.output ? { output_schema: outputJsonSchema(tool.output) } : {}),
        ...(tool.examples.length ? { examples: tool.examples } : {}),
      };
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    },
  );

  register(
    "call_tool",
    {
      title: "Run a tool",
      description:
        "Run a tool found with search_tools, with arguments that match its schema from describe_tool. A tool marked requires_confirm needs confirming: the user is asked to approve it where the client can ask, and otherwise it runs only with confirm: true, which you pass only when the user asked for that exact action.",
      inputSchema: z.object({
        name: z.string().min(1).describe("The tool name."),
        arguments: z.record(z.string(), z.unknown()).optional().describe("The tool's arguments, as its schema describes them."),
        confirm: z.boolean().optional().describe("Required for tools marked requires_confirm."),
      }),
      annotations: { title: "Run a tool", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ name, arguments: args, confirm }, ctx) => {
      const tool = visible().find((candidate) => candidate.name === name);
      if (!tool) return errorResult(new UsageError(`No tool named '${name}'. Use search_tools to find one.`), app.secrets);
      try {
        const parsed = await app.parse(tool, args ?? {});
        // call_tool's own entry carries no request for a person, so Claude Code did not prompt for this tool.
        const confirmed = await confirmFirst(server, app, tool, parsed, ctx, env, policy, false);
        if ("ask" in confirmed) return confirmed.ask;
        let cached: { ageSeconds: number } | undefined;
        const value = await app.run(tool, parsed, {
          surface: "mcp",
          confirmed: confirm === true,
          approvedBy: confirmed.approvedBy,
          signal: ctx.mcpReq.signal,
          env,
          onProgress: progressFor(ctx),
          onCache: (hit) => (cached = hit),
        });
        const result = withCacheNote(toCallToolResult(tool, value, app.secrets), cached);
        // This tool declares no output schema, so only an object may travel as structured content.
        if (result.structuredContent !== undefined && !isPlainObject(result.structuredContent)) delete result.structuredContent;
        return result;
      } catch (error) {
        return errorResult(toSlipwayError(error), app.secrets);
      }
    },
  );
}

function registerResource<Ctx>(server: McpServer, app: App<Ctx>, resource: ResourceDefinition<Ctx>, env: NodeJS.ProcessEnv): void {
  const mimeType = resource.mimeType ?? "application/json";
  server.registerResource(
    resource.name,
    resource.uri,
    {
      ...(resource.title ? { title: resource.title } : {}),
      ...(resource.description ? { description: resource.description } : {}),
      mimeType,
    },
    async (uri: URL) => {
      const value = await resource.read(await app.context(env));
      const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      return { contents: [{ uri: uri.href, mimeType, text: app.secrets.redact(body) }] };
    },
  );
}

function registerPrompt<Ctx>(server: McpServer, app: App<Ctx>, prompt: PromptDefinition<Ctx>, env: NodeJS.ProcessEnv): void {
  const respond = async (args: Record<string, string>) => {
    const text = await prompt.render(args, await app.context(env));
    return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
  };
  const config = {
    ...(prompt.title ? { title: prompt.title } : {}),
    ...(prompt.description ? { description: prompt.description } : {}),
  };
  const register = server.registerPrompt.bind(server) as unknown as (
    name: string,
    config: Record<string, unknown>,
    cb: (...args: any[]) => unknown,
  ) => unknown;
  // Without an argument schema the SDK passes only its context, so the callback shape differs.
  if (prompt.args) register(prompt.name, { ...config, argsSchema: prompt.args }, (args: Record<string, string>) => respond(args ?? {}));
  else register(prompt.name, config, () => respond({}));
}
