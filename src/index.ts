/**
 * Slipway: one tool definition ships an MCP server and an agent-native CLI.
 */

export { slipway, stderrLogger } from "./app.js";
export type {
  App,
  AppDefinition,
  CliIO,
  DoctorCheck,
  DryRun,
  InvokeOptions,
  PromptDefinition,
  ResourceDefinition,
  ServiceSetting,
} from "./app.js";

export { defineTool, isTool, toolkit } from "./tool.js";
export type { CacheOptions, Logger, Paginate, Risk, RunContext, Surface, SyncOptions, Tool, ToolContext, ToolDefinition, ToolExample } from "./tool.js";

export { emptyInput, inputJsonSchema, jsonSchema, outputJsonSchema, validate, CONFIRM_DESCRIPTION } from "./schema.js";
export type { InferInput, InferOutput, JsonSchema, Schema } from "./schema.js";

export {
  ApiError,
  AuthError,
  CanceledError,
  EXIT,
  NotConfiguredError,
  NotFoundError,
  RateLimitError,
  RefusedError,
  SlipwayError,
  TimeoutError,
  UsageError,
  httpError,
  toSlipwayError,
} from "./errors.js";
export type { ErrorCode, ErrorPayload } from "./errors.js";

export { audio, content, file, image, resourceLink, text } from "./result.js";
export type { ContentResult } from "./result.js";

export { readPolicy, policyEnvNames } from "./policy.js";
export type { ConfirmMode, Policy, PolicyDefaults, ToolSurface } from "./policy.js";

export { fromOpenAPI, httpExecutor, openapiHash, readOperations, toJsonSchema, toolName } from "./openapi.js";
export type { Executor, FromOpenAPIOptions, HttpExecutorOptions, Operation, OperationInput, OperationParameter, SkippedOperation } from "./openapi.js";

export type { BackgroundJob, JobDefinition, JobProgress, JobResult, ServiceJob } from "./jobs.js";
export type { DataStore, SearchHit, SyncedTool } from "./data.js";
export type { SyncReport } from "./sync.js";
export { CLIENTS } from "./install.js";
export type { ClientId } from "./install.js";

export { Secrets } from "./redact.js";
export { annotationsFor, CACHE_META, MAX_RESULT_SIZE_CHARS, REQUIRES_USER_INTERACTION } from "./server.js";
export { renderDocs, settingsTable, toolReference, toolTable } from "./docs.js";

/** The Zod instance Slipway is built against. Use it, so every schema in an app comes from one copy. */
export { z } from "zod";
