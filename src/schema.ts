/**
 * One schema interface for every tool, whatever wrote it.
 *
 * A hand-written tool uses Zod. A tool generated from an API contract uses the
 * contract's JSON Schema. Both become a Standard Schema object here, which is
 * what the MCP SDK validates and advertises, and what the CLI derives its
 * flags from. Because both surfaces read the same object, an argument one
 * accepts the other accepts too.
 */

import { fromJsonSchema, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";

export type JsonSchema = Record<string, unknown>;
export type Schema<Input = unknown, Output = Input> = StandardSchemaWithJSON<Input, Output>;

/** What the Standard Schema spec says a schema declares about its own types. */
type Types<S> = S extends { readonly "~standard": { readonly types?: infer T } } ? NonNullable<T> : never;
/** What a caller passes. */
export type InferInput<S> = Types<S> extends { readonly input: infer I } ? I : Record<string, unknown>;
/** What a handler receives, after defaults and transforms. */
export type InferOutput<S> = Types<S> extends { readonly output: infer O } ? O : Record<string, unknown>;

export type Issue = { path: string; message: string };

const TARGET = { target: "draft-2020-12" } as const;

/**
 * Wrap a raw JSON Schema so it validates and converts like a Zod schema.
 *
 * This is how a tool generated from an OpenAPI document or a pinned contract
 * joins the same tool list as hand-written ones.
 *
 * The validator compiles on the tool's first call, not when the server starts.
 * Compiling all 123 schemas of one server up front held its first answer back
 * by 118 ms, for tools most sessions never call. `slipway check` compiles every
 * one, so a schema that cannot compile still fails before release.
 */
export function jsonSchema<T = Record<string, unknown>>(schema: JsonSchema): Schema<T, T> {
  let compiled: Schema<T, T> | undefined;
  return {
    "~standard": {
      version: 1,
      vendor: "mcp",
      jsonSchema: { input: () => schema, output: () => schema },
      validate: (value: unknown) => (compiled ??= fromJsonSchema<T>(schema))["~standard"].validate(value),
    },
  };
}

/** The input of a tool that takes nothing. */
export function emptyInput(): Schema<Record<string, never>> {
  return jsonSchema<Record<string, never>>({ type: "object", properties: {}, additionalProperties: false });
}

export function isSchema(value: unknown): value is Schema {
  const std = (value as { "~standard"?: { validate?: unknown; jsonSchema?: { input?: unknown } } } | undefined)?.[
    "~standard"
  ];
  return typeof std?.validate === "function" && typeof std.jsonSchema?.input === "function";
}

/** The JSON Schema an MCP client receives for this input. */
export function inputJsonSchema(schema: Schema): JsonSchema {
  return schema["~standard"].jsonSchema.input(TARGET);
}

export function outputJsonSchema(schema: Schema): JsonSchema {
  return schema["~standard"].jsonSchema.output(TARGET);
}

/** Validate with the schema's own validator, sync or async, and flatten the issues. */
export async function validate<T>(
  schema: Schema<unknown, T>,
  value: unknown,
): Promise<{ ok: true; value: T } | { ok: false; issues: Issue[] }> {
  const result = await schema["~standard"].validate(value);
  if (result.issues) {
    return {
      ok: false,
      issues: result.issues.map((issue) => ({
        path: (issue.path ?? [])
          .map((part) => (typeof part === "object" && part !== null && "key" in part ? String(part.key) : String(part)))
          .join("."),
        message: plainMessage(issue.message),
      })),
    };
  }
  return { ok: true, value: result.value };
}

/**
 * A JSON Schema validator names fields as `data/a/b`. A person typing flags,
 * and a model reading the error, both know the field as `a.b`.
 */
function plainMessage(message: string): string {
  return message
    .replace(/\bdata\/([A-Za-z0-9_.\-/]+)/g, (_match, path: string) => path.replace(/\//g, "."))
    .replace(/\bdata (must|should)\b/g, "input $1");
}

export function formatIssues(issues: Issue[]): string {
  return issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join("; ");
}

/** Arguments Slipway adds to a tool's input. They never reach the tool author's schema or handler. */
export type Controls = { confirm?: boolean; wait_seconds?: number };

/** The names Slipway adds, which a tool's own input may not use. */
export const CONTROL_NAMES = ["confirm", "wait_seconds"] as const;

/**
 * Short on purpose: it is repeated in every confirmed tool a client lists.
 * What the effect is lives in the tool's own description and annotations.
 */
export const CONFIRM_DESCRIPTION = "Set true only when the user asked for exactly this action.";

/** The schema already carries the range and the default, so the words only say what the number is for. */
export const WAIT_DESCRIPTION = "Seconds to wait for the job to finish before returning it to check later.";

/** Keywords whose keys are names the author chose, not keywords. */
const NAMED = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);

/**
 * Zod 4 gives every whole number the safe-integer bounds, `maximum:
 * 9007199254740991` and its negative, unless the schema sets its own, and
 * every record `propertyNames: { type: "string" }`, which every JSON object key
 * already is. They say nothing a client can use, so they are left out of what
 * it receives. Validation still runs on the schema itself. An argument that
 * happens to be named `propertyNames` or `maximum` is a name, so it stays.
 */
function withoutNoise(node: unknown, named = false): unknown {
  if (Array.isArray(node)) return node.map((item) => withoutNoise(item));
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!named) {
      if ((key === "maximum" && value === Number.MAX_SAFE_INTEGER) || (key === "minimum" && value === Number.MIN_SAFE_INTEGER)) continue;
      if (key === "propertyNames" && isPlainString(value)) continue;
    }
    out[key] = withoutNoise(value, !named && NAMED.has(key));
  }
  return out;
}

function isPlainString(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && (value as { type?: unknown }).type === "string";
}

/**
 * A schema as clients receive it, without the `$schema` line that names its
 * dialect. A client reads JSON Schema 2020-12 when no dialect is named, so
 * the line only adds bytes to every tool in every listing.
 */
export function advertised<I, O>(schema: Schema<I, O>): Schema<I, O> {
  const std = schema["~standard"];
  const plain = (json: JsonSchema): JsonSchema => {
    const { $schema: _dialect, ...rest } = json;
    return withoutNoise(rest) as JsonSchema;
  };
  return {
    "~standard": {
      version: std.version,
      vendor: std.vendor,
      validate: (value: unknown) => std.validate(value),
      ...(std.types ? { types: std.types } : {}),
      jsonSchema: {
        input: (options) => plain(std.jsonSchema.input(options)),
        output: (options) => plain(std.jsonSchema.output(options)),
      },
    },
  } as Schema<I, O>;
}

/**
 * Add Slipway's own arguments to any schema: `confirm` for a tool that needs
 * confirming, `wait_seconds` for a job.
 *
 * Validation takes them out before the author's schema sees the rest and puts
 * them back afterwards, so a strict contract schema with
 * `additionalProperties: false` still accepts them, and the author never
 * declares them by hand.
 */
export function withControls<I, O>(
  schema: Schema<I, O>,
  controls: { confirm: boolean; wait?: { defaultSeconds: number; maxSeconds: number } },
): Schema<I & Controls, O & Controls> {
  if (!controls.confirm && !controls.wait) return schema as unknown as Schema<I & Controls, O & Controls>;
  const std = schema["~standard"];
  const wait = controls.wait;
  return {
    "~standard": {
      version: 1,
      vendor: "slipway",
      validate: (value: unknown) => {
        const record = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
        if (!record) return std.validate(value) as never;
        const { confirm, wait_seconds: waitSeconds, ...rest } = record;
        const issues: Array<{ message: string; path: string[] }> = [];
        if (controls.confirm && confirm !== undefined && typeof confirm !== "boolean") issues.push({ message: "Expected true or false", path: ["confirm"] });
        if (wait && waitSeconds !== undefined && (typeof waitSeconds !== "number" || !Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > wait.maxSeconds)) {
          issues.push({ message: `Expected a whole number of seconds from 0 to ${wait.maxSeconds}`, path: ["wait_seconds"] });
        }
        if (issues.length) return { issues };
        // A control this tool does not take stays in the input, for the author's schema to judge.
        const passOn = { ...rest, ...(!controls.confirm && confirm !== undefined ? { confirm } : {}), ...(!wait && waitSeconds !== undefined ? { wait_seconds: waitSeconds } : {}) };
        const finish = (result: Awaited<ReturnType<typeof std.validate>>) =>
          result.issues
            ? result
            : {
                value: {
                  ...(result.value as object),
                  ...(controls.confirm && confirm !== undefined ? { confirm } : {}),
                  ...(wait && waitSeconds !== undefined ? { wait_seconds: waitSeconds } : {}),
                },
              };
        const result = std.validate(passOn);
        return (result instanceof Promise ? result.then(finish) : finish(result)) as never;
      },
      jsonSchema: {
        input: (options) => {
          const base = std.jsonSchema.input(options);
          const properties = { ...((base.properties as Record<string, unknown>) ?? {}) };
          if (controls.confirm) properties.confirm = { type: "boolean", description: CONFIRM_DESCRIPTION };
          if (wait) {
            properties.wait_seconds = { type: "integer", minimum: 0, maximum: wait.maxSeconds, default: wait.defaultSeconds, description: WAIT_DESCRIPTION };
          }
          return { ...base, properties };
        },
        output: (options) => std.jsonSchema.output(options),
      },
    },
  } as Schema<I & Controls, O & Controls>;
}

/** Serialized size of a schema, the number that decides what a client pays to load the tool. */
export function schemaBytes(schema: JsonSchema): number {
  return Buffer.byteLength(JSON.stringify(schema));
}

/**
 * Find `$defs` blocks that repeat inside one schema.
 *
 * A generator that inlines a referenced body and also keeps it under `$defs`
 * ships the same definitions twice; a schema of a few hundred kilobytes is
 * often half repetition.
 */
export function repeatedDefinitions(schema: JsonSchema): string[] {
  const seen = new Map<string, number>();
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    const record = node as Record<string, unknown>;
    for (const key of ["$defs", "definitions"]) {
      const defs = record[key];
      if (defs && typeof defs === "object") {
        for (const [name, value] of Object.entries(defs)) {
          const fingerprint = `${name}:${JSON.stringify(value).length}`;
          seen.set(fingerprint, (seen.get(fingerprint) ?? 0) + 1);
        }
      }
    }
    Object.values(record).forEach(visit);
  };
  visit(schema);
  return [...seen.entries()].filter(([, count]) => count > 1).map(([fingerprint]) => fingerprint.split(":")[0] as string);
}
