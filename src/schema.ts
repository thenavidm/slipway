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
 *
 * `shareRepeats: true` advertises the schema with each repeated part written
 * once, as `shareRepeats()` describes.
 */
export function jsonSchema<T = Record<string, unknown>>(schema: JsonSchema, options: { shareRepeats?: boolean } = {}): Schema<T, T> {
  let compiled: Schema<T, T> | undefined;
  let shared: JsonSchema | undefined;
  // Shared on first use, like the validator, so a command that never lists this tool never pays for it.
  const advertisedSchema = (): JsonSchema => (options.shareRepeats ? (shared ??= shareRepeats(schema)) : schema);
  return {
    "~standard": {
      version: 1,
      vendor: "mcp",
      jsonSchema: { input: advertisedSchema, output: advertisedSchema },
      validate: (value: unknown) => (compiled ??= fromJsonSchema<T>(advertisedSchema()))["~standard"].validate(value),
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

/**
 * The top-level argument names of an input. A Zod object names them in its
 * shape, so defining a tool never turns its schema into JSON Schema: that took
 * Facebook's 27 tools 3.7 ms of CPU before the server's first answer, and the
 * SDK converts each one again for `tools/list`.
 */
export function propertyNames(schema: Schema): string[] {
  const shape = (schema as { shape?: unknown }).shape;
  if (shape !== null && typeof shape === "object") return Object.keys(shape);
  return Object.keys((schema["~standard"].jsonSchema.input(TARGET).properties as Record<string, unknown> | undefined) ?? {});
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

/** Keywords whose value is one subschema. */
const ONE_SCHEMA = new Set(["items", "additionalItems", "additionalProperties", "contains", "not", "if", "then", "else", "propertyNames", "unevaluatedItems", "unevaluatedProperties", "contentSchema"]);
/** Keywords whose value is a list of subschemas. */
const SCHEMA_LIST = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
/** Keywords whose value maps names to subschemas. */
const SCHEMA_MAP = new Set(["properties", "patternProperties", "dependentSchemas", "$defs", "definitions"]);
/** A part that carries one of these stays where it is: something may point into it, or it changes how references inside it resolve. */
const ANCHORED = ["$id", "$anchor", "$dynamicAnchor", "$defs", "definitions"];
/** Smaller parts stay inline, so the schema still reads top to bottom. */
const SHARE_MIN_BYTES = 200;
const CHILD = Symbol("child");

type Part = { template: unknown; bytes: number; label: string; movable: boolean; parents: Map<number, number> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Every `$ref` in the schema points into its own definitions, so moving any other part breaks none of them. */
function refsOnlyInto(node: unknown, prefix: string): boolean {
  if (Array.isArray(node)) return node.every((item) => refsOnlyInto(item, prefix));
  if (!isRecord(node)) return true;
  if (node.$ref !== undefined && !(typeof node.$ref === "string" && node.$ref.startsWith(prefix))) return false;
  return Object.values(node).every((value) => refsOnlyInto(value, prefix));
}

/** A definition name a JSON pointer carries as is: letters, digits, `_`, `.` and `-`. */
function definitionName(label: string): string {
  return label.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) || "shared";
}

/** What to call one of several options: its title, or the value its `type` property is fixed to, such as `paragraph`. */
function optionLabel(option: unknown, parent: string): string {
  if (!isRecord(option)) return `${parent}_option`;
  if (typeof option.title === "string") return option.title;
  const discriminator = isRecord(option.properties) && isRecord(option.properties.type) ? option.properties.type : undefined;
  const fixed = discriminator?.const ?? (Array.isArray(discriminator?.enum) && discriminator.enum.length === 1 ? discriminator.enum[0] : undefined);
  return typeof fixed === "string" ? fixed : `${parent}_option`;
}

/**
 * The same schema with each part that repeats written once, under `$defs`, and
 * referred to with `$ref` everywhere it appeared.
 *
 * A schema generated from an API contract often spells one definition out
 * everywhere it is used: one newsletter API's post body repeats the same
 * styling block 33 times, and its create-post tool came to 378 KB, where
 * sharing the repeats leaves 37 KB. Nothing is lost: each part reads the
 * same, and Claude Code and Codex both read fields that appear only under
 * `$defs`. Parts under 200 bytes stay inline, so the schema still reads top
 * to bottom.
 *
 * A schema with a `$ref` to anything but its own definitions is returned as
 * it is, since moving a part could break that reference. The work is linear in
 * the schema's size: each distinct part is serialized once.
 */
export function shareRepeats(schema: JsonSchema, options: { minBytes?: number } = {}): JsonSchema {
  const minBytes = options.minBytes ?? SHARE_MIN_BYTES;
  const key = !("$defs" in schema) && "definitions" in schema ? "definitions" : "$defs";
  if ("$defs" in schema && "definitions" in schema) return schema;
  if (!refsOnlyInto(schema, `#/${key}/`)) return schema;

  // Each distinct part once, by a signature built from its children's ids, so serializing is linear.
  const parts: Part[] = [];
  const ids = new Map<string, number>();
  const build = (node: unknown, label: string): number => {
    if (!isRecord(node)) {
      const json = JSON.stringify(node);
      const known = ids.get(json);
      if (known !== undefined) return known;
      parts.push({ template: node, bytes: Buffer.byteLength(json), label, movable: false, parents: new Map() });
      ids.set(json, parts.length - 1);
      return parts.length - 1;
    }
    const own = typeof node.title === "string" ? node.title : label;
    const template: Record<string, unknown> = {};
    const signature: string[] = [];
    const children: number[] = [];
    let bytes = 2 + Math.max(0, Object.keys(node).length - 1);
    const child = (value: unknown, childLabel: string): { mark: unknown; sig: string; bytes: number } => {
      const id = build(value, childLabel);
      children.push(id);
      return { mark: { [CHILD]: id }, sig: `#${id}`, bytes: parts[id]!.bytes };
    };
    for (const [name, value] of Object.entries(node)) {
      let entry: { mark: unknown; sig: string; bytes: number };
      if (ONE_SCHEMA.has(name) && (isRecord(value) || typeof value === "boolean")) {
        entry = child(value, name === "items" ? `${own}_item` : own);
      } else if ((SCHEMA_LIST.has(name) || name === "items") && Array.isArray(value)) {
        const list = value.map((item) => child(item, optionLabel(item, own)));
        entry = { mark: list.map((item) => item.mark), sig: `[${list.map((item) => item.sig).join(",")}]`, bytes: 2 + Math.max(0, list.length - 1) + list.reduce((sum, item) => sum + item.bytes, 0) };
      } else if (SCHEMA_MAP.has(name) && isRecord(value)) {
        const map = Object.entries(value).map(([field, sub]) => [JSON.stringify(field), child(sub, field)] as const);
        entry = {
          mark: Object.fromEntries(map.map(([field, item]) => [JSON.parse(field) as string, item.mark])),
          sig: `{${map.map(([field, item]) => `${field}:${item.sig}`).join(",")}}`,
          bytes: 2 + Math.max(0, map.length - 1) + map.reduce((sum, [field, item]) => sum + Buffer.byteLength(field) + 1 + item.bytes, 0),
        };
      } else {
        const json = JSON.stringify(value);
        entry = { mark: value, sig: json, bytes: Buffer.byteLength(json) };
      }
      template[name] = entry.mark;
      signature.push(`${JSON.stringify(name)}:${entry.sig}`);
      bytes += Buffer.byteLength(JSON.stringify(name)) + 1 + entry.bytes;
    }
    const sig = `{${signature.join(",")}}`;
    const known = ids.get(sig);
    if (known !== undefined) return known;
    const id = parts.length;
    parts.push({ template, bytes, label: own, movable: !ANCHORED.some((anchor) => anchor in node), parents: new Map() });
    ids.set(sig, id);
    for (const c of children) parts[c]!.parents.set(id, (parts[c]!.parents.get(id) ?? 0) + 1);
    return id;
  };

  const { [key]: existingDefs, ...rest } = schema;
  const root = build(rest, "");
  const names = new Map<number, string>();
  const taken = new Set<string>();
  const defsOrder: number[] = [];
  // Two definitions with the same body keep both names: references in the schema use either.
  const aliases: Array<[string, number]> = [];
  for (const [name, body] of Object.entries(isRecord(existingDefs) ? existingDefs : {})) {
    const id = build(body, name);
    if (names.has(id)) aliases.push([name, id]);
    else {
      names.set(id, name);
      defsOrder.push(id);
    }
    taken.add(name);
  }

  // How many times each part would be written out, deciding the larger ones first: a part is always larger than
  // anything inside it, so every part that could contain this one is already decided.
  const appear = new Array<number>(parts.length).fill(0);
  appear[root] = 1;
  for (const id of defsOrder) appear[id] = Math.max(appear[id]!, 1);
  const order = parts.map((_, id) => id).sort((a, b) => parts[b]!.bytes - parts[a]!.bytes);
  for (const id of order) {
    const part = parts[id]!;
    for (const [parent, times] of part.parents) appear[id]! += times * (names.has(parent) ? 1 : appear[parent]!);
    if (id === root || names.has(id) || !part.movable || part.bytes < minBytes || appear[id]! < 2) continue;
    let name = definitionName(part.label);
    for (let n = 2; taken.has(name); n++) name = `${definitionName(part.label)}_${n}`;
    const ref = Buffer.byteLength(JSON.stringify({ $ref: `#/${key}/${name}` }));
    if ((appear[id]! - 1) * part.bytes - appear[id]! * ref - name.length - 4 <= 0) continue;
    names.set(id, name);
    taken.add(name);
    defsOrder.push(id);
  }
  if (!names.size) return schema;

  const fill = (template: unknown): unknown => {
    if (Array.isArray(template)) return template.map(fill);
    if (!isRecord(template)) return template;
    const marked = (template as { [CHILD]?: number })[CHILD];
    if (marked !== undefined) return emit(marked, false);
    return Object.fromEntries(Object.entries(template).map(([name, value]) => [name, fill(value)]));
  };
  const emit = (id: number, asDefinition: boolean): unknown => {
    const name = names.get(id);
    return name !== undefined && !asDefinition ? { $ref: `#/${key}/${name}` } : fill(parts[id]!.template);
  };
  const out = fill(parts[root]!.template) as JsonSchema;
  out[key] = Object.fromEntries([
    ...defsOrder.map((id) => [names.get(id)!, emit(id, true)]),
    ...aliases.map(([name, id]) => [name, { $ref: `#/${key}/${names.get(id)!}` }]),
  ]);
  // Nothing repeated, or only a definition that every use already refers to: the schema stays the object it was.
  return schemaBytes(out) < schemaBytes(schema) ? out : schema;
}

/**
 * A property that is only a reference into the schema's own definitions, read
 * as the definition it points to, with its own words first.
 */
export function resolveLocalRef<T extends Record<string, unknown>>(root: JsonSchema, node: T): T {
  let current: Record<string, unknown> = node;
  for (let hop = 0; hop < 8 && typeof current.$ref === "string"; hop++) {
    const match = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(current.$ref);
    const defs = match ? root[match[1]!] : undefined;
    const target = match && isRecord(defs) ? defs[match[2]!.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
    if (!isRecord(target)) break;
    const { $ref: _ref, ...own } = current;
    current = { ...target, ...own };
  }
  return current as T;
}
