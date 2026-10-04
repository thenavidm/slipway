/**
 * Tools from an OpenAPI document.
 *
 * An API that publishes OpenAPI already says what every operation takes. This
 * turns each operation into a tool with that input, the risk its HTTP method
 * implies, and its tags as toolsets, so a large API becomes a server and a CLI
 * without a hand-written tool per endpoint. The tools join the same list as
 * hand-written ones and go through the same guard.
 *
 * A generated tool is only as trustworthy as the document it came from, so a
 * document can be pinned by hash: a changed document refuses to build until
 * someone has looked at what changed and updated the pin.
 */

import { UsageError, httpError } from "./errors.js";
import { CONTROL_NAMES, jsonSchema, type JsonSchema } from "./schema.js";
import { defineTool, type Risk, type Tool, type ToolContext } from "./tool.js";
import { sha256, stableJson } from "./util.js";

export type OperationParameter = {
  /** The parameter's name in the API. */
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  /** The input property that carries it. */
  property: string;
  /** How the value is written, as the document says: form and deepObject in a query, simple in a path or header. */
  style: string;
  explode: boolean;
};

export type Operation = {
  operationId: string;
  /** Upper case: GET, POST. */
  method: string;
  /** The path template: /pets/{petId}. */
  path: string;
  summary?: string;
  description?: string;
  tags: string[];
  deprecated: boolean;
  parameters: OperationParameter[];
  /**
   * The request body, and how the input carries it: spread into the input's
   * own properties, or as one `body` property. `fields` maps each input
   * property back to the body field it carries, which differs where a field's
   * own name was taken.
   */
  body?: { contentType: string; required: boolean; spread: boolean; fields: Record<string, string> };
  /** The tool's input, as JSON Schema 2020-12. */
  input: JsonSchema;
  /** The JSON schema of a successful response, when the document gives one. */
  output?: JsonSchema;
};

/** What one call sends, split the way HTTP carries it. */
export type OperationInput = {
  path: Record<string, unknown>;
  query: Record<string, unknown>;
  headers: Record<string, string>;
  body?: unknown;
};

/** Runs one operation. `httpExecutor` covers JSON and form APIs; write your own for anything else. */
export type Executor<Ctx> = (operation: Operation, input: OperationInput, ctx: ToolContext<Ctx>) => unknown | Promise<unknown>;

export type FromOpenAPIOptions<Ctx> = {
  execute: Executor<Ctx>;
  /** Only these operations, by operationId, or the ones a test accepts. */
  include?: readonly string[] | ((operation: Operation) => boolean);
  /** Tool names by operationId, where the generated one reads badly. */
  names?: Record<string, string>;
  /** Risk by operationId, where the method misleads: a POST that only searches is a read. */
  risk?: Record<string, Risk>;
  /** Refuse to build from a document whose hash differs. `slipway openapi <file>` prints the hash to pin. */
  pin?: { sha256: string };
  /** Declare each operation's documented JSON response as the tool's output. Off by default, since APIs often return more than they document. */
  typedOutput?: boolean;
  /** Put before every tool name, to keep two APIs in one app apart. */
  prefix?: string;
};

export type SkippedOperation = { method: string; path: string; operationId?: string; reason: string };

type Doc = Record<string, unknown>;

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
const READS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);
/** Headers the transport sets itself, which a tool never takes as arguments. */
const TRANSPORT_HEADERS = new Set(["authorization", "content-type", "accept", "content-length", "user-agent", "host", "cookie"]);
/** Formats the validator understands. Any other format is left out, since an unknown one prints a warning every time the schema loads. */
const KNOWN_FORMATS = new Set([
  "int32", "int64", "float", "double", "byte", "binary", "password", "date", "date-time", "time", "duration", "uuid", "email",
  "uri", "uri-reference", "uri-template", "url", "hostname", "ipv4", "ipv6", "regex", "json-pointer", "relative-json-pointer",
]);
const PROPERTY = /^[A-Za-z0-9_.-]{1,64}$/;
/** Names an API's own arguments cannot take: Slipway's controls, and the property that carries a body that is not spread. */
const RESERVED = new Set<string>([...CONTROL_NAMES, "body"]);
const MAX_DEPTH = 40;
/**
 * How many references deep an object schema is expanded. Large APIs refer
 * from object to object to object, and expanding every path in full grows
 * without bound. Below this depth an object is described rather than spelled
 * out, and the API itself checks it.
 */
const MAX_REF_DEPTH = 3;
const MAX_DESCRIPTION = 1_000;

/** The hash to pin a document by: the same for the same content, however its keys were ordered. */
export function openapiHash(document: unknown): string {
  return sha256(stableJson(document));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pointer(document: Doc, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    throw new UsageError(`Only references inside the document are supported, not '${ref}'. Bundle the document into one file first.`);
  }
  let node: unknown = document;
  for (const raw of ref.slice(2).split("/")) {
    const part = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isRecord(node) && !Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  if (node === undefined) throw new UsageError(`The reference '${ref}' points at nothing in the document.`);
  return node;
}

/** A schema small enough to inline at any depth: a plain value, a list of choices. */
function isSmall(node: unknown): boolean {
  if (!isRecord(node)) return true;
  if (node.$ref !== undefined || node.properties !== undefined || node.items !== undefined || node.allOf || node.anyOf || node.oneOf || isRecord(node.additionalProperties)) return false;
  return true;
}

/**
 * Inline `$ref`s. A schema that refers to itself, such as a tree of comments,
 * is cut at the second visit, and an object more than a few references deep
 * is described rather than spelled out, so a large API's schemas stay a size
 * a model can read. Results are memoized per reference and depth, since large
 * documents refer to the same schemas thousands of times.
 */
function resolver(document: Doc) {
  const memo = new Map<string, unknown>();
  const resolve = (node: unknown, seen: readonly string[] = [], depth = 0): unknown => {
    if (depth > MAX_DEPTH) return {};
    if (Array.isArray(node)) return node.map((item) => resolve(item, seen, depth + 1));
    if (!isRecord(node)) return node;
    if (typeof node.$ref === "string") {
      const ref = node.$ref;
      const { $ref: _ref, ...siblings } = node;
      const name = ref.split("/").pop();
      const raw = pointer(document, ref);
      const extra = resolve(siblings, seen, depth + 1) as Record<string, unknown>;
      if (seen.includes(ref) || (seen.length >= MAX_REF_DEPTH && !isSmall(raw))) {
        const about = isRecord(raw) && typeof raw.description === "string" ? ` ${clip(raw.description, 200)}` : "";
        return { ...extra, description: (extra.description as string | undefined) ?? `A ${name}, not spelled out here: the API checks its fields.${about}` };
      }
      const key = `${ref}\0${seen.length}`;
      if (!memo.has(key)) memo.set(key, resolve(raw, [...seen, ref], depth + 1));
      const target = memo.get(key);
      return isRecord(target) ? { ...target, ...extra } : target;
    }
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, resolve(value, seen, depth + 1)]));
  };
  return resolve;
}

/**
 * An OpenAPI schema as JSON Schema 2020-12: `nullable` becomes a null type,
 * 3.0's boolean exclusive bounds become numbers, `example` becomes
 * `examples`, and keys that only mean something to OpenAPI are dropped.
 * Properties the server sets itself (`readOnly`) leave a request's input.
 */
export function toJsonSchema(node: unknown, forInput: boolean): unknown {
  if (Array.isArray(node)) return node.map((item) => toJsonSchema(item, forInput));
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("x-") || ["discriminator", "xml", "externalDocs", "nullable", "example", "$id", "$schema", "$anchor", "deprecated"].includes(key)) continue;
    if (key === "format" && (typeof value !== "string" || !KNOWN_FORMATS.has(value))) continue;
    if (key === "exclusiveMinimum" && typeof value === "boolean") {
      if (value && typeof node.minimum === "number") out.exclusiveMinimum = node.minimum;
      continue;
    }
    if (key === "exclusiveMaximum" && typeof value === "boolean") {
      if (value && typeof node.maximum === "number") out.exclusiveMaximum = node.maximum;
      continue;
    }
    if ((key === "minimum" && node.exclusiveMinimum === true) || (key === "maximum" && node.exclusiveMaximum === true)) continue;
    if (key === "properties" && isRecord(value)) {
      const properties: Record<string, unknown> = {};
      for (const [name, schema] of Object.entries(value)) {
        if (forInput && isRecord(schema) && schema.readOnly === true) continue;
        properties[name] = toJsonSchema(schema, forInput);
      }
      out.properties = properties;
      continue;
    }
    // Values are data, not schemas, so they pass through untouched.
    out[key] = ["default", "const", "enum", "examples"].includes(key) ? value : isRecord(value) || Array.isArray(value) ? toJsonSchema(value, forInput) : value;
  }
  if (forInput && Array.isArray(out.required) && isRecord(out.properties)) {
    const kept = (out.required as unknown[]).filter((name) => typeof name === "string" && name in (out.properties as Record<string, unknown>));
    if (kept.length) out.required = kept;
    else delete out.required;
  }
  if (node.example !== undefined && out.examples === undefined) out.examples = [toJsonSchema(node.example, false)];
  if (node.nullable === true) {
    if (typeof out.type === "string") out.type = [out.type, "null"];
    else if (Array.isArray(out.type) && !out.type.includes("null")) out.type = [...out.type, "null"];
    else if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
    else if (out.type === undefined) return { anyOf: [out, { type: "null" }] };
  }
  return out;
}

/**
 * operationId as a tool name: listPets and pets.list become list_pets and
 * pets_list. A name past the 64 characters clients allow keeps its start and
 * ends in a short hash of the id, so two long ids that begin alike stay
 * two names, and the same id always gets the same one.
 */
export function toolName(id: string): string {
  const snake = id
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  const name = /^[a-z]/.test(snake) ? snake : `op_${snake}`;
  if (name.length <= 64) return name;
  return `${name.slice(0, 55).replace(/_+$/, "")}_${sha256(id).slice(0, 8)}`;
}

function slug(tag: string): string {
  return tag.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function words(id: string): string {
  const spaced = id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_.-]+/g, " ").trim().toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function clip(text: string, max: number): string {
  const clean = text.trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** The media type a body is sent as: JSON first, then a form. Anything else cannot be built from arguments. */
function bodyType(content: Record<string, unknown>): string | undefined {
  const types = Object.keys(content);
  return (
    types.find((type) => /^application\/json\b/i.test(type)) ??
    types.find((type) => /\+json\b/i.test(type)) ??
    types.find((type) => /^application\/x-www-form-urlencoded\b/i.test(type))
  );
}

/** Every operation in a document, as tools would see it, and the ones that cannot become tools, with why. */
export function readOperations(document: unknown, options: { typedOutput?: boolean } = {}): { operations: Operation[]; skipped: SkippedOperation[] } {
  if (!isRecord(document)) throw new UsageError("An OpenAPI document is a JSON object.");
  if (typeof document.swagger === "string") throw new UsageError("This is a Swagger 2.0 document. Convert it to OpenAPI 3 first.");
  if (typeof document.openapi !== "string" || !/^3\./.test(document.openapi)) throw new UsageError("This is not an OpenAPI 3 document: it has no openapi: 3.x field.");
  const paths = isRecord(document.paths) ? document.paths : {};
  const operations: Operation[] = [];
  const skipped: SkippedOperation[] = [];
  const resolve = resolver(document);

  for (const [path, rawItem] of Object.entries(paths)) {
    // Only what a tool's input needs is resolved: parameters and the body, and responses only for typed output.
    const item = (isRecord(rawItem) && typeof rawItem.$ref === "string" ? pointer(document, rawItem.$ref) : rawItem) as Record<string, unknown>;
    if (!isRecord(item)) continue;
    const shared = Array.isArray(item.parameters) ? (resolve(item.parameters) as Array<Record<string, unknown>>) : [];
    for (const method of METHODS) {
      const rawOp = item[method];
      if (!isRecord(rawOp)) continue;
      const op: Record<string, unknown> = {
        ...rawOp,
        ...(rawOp.parameters ? { parameters: resolve(rawOp.parameters) } : {}),
        ...(rawOp.requestBody ? { requestBody: resolve(rawOp.requestBody) } : {}),
        ...(options.typedOutput && rawOp.responses ? { responses: resolve(rawOp.responses) } : {}),
      };
      const verb = method.toUpperCase();
      const operationId = typeof op.operationId === "string" && op.operationId ? op.operationId : `${method}_${path}`;
      const skip = (reason: string) => skipped.push({ method: verb, path, ...(typeof op.operationId === "string" ? { operationId: op.operationId } : {}), reason });

      // An operation's own parameter replaces a path-level one with the same name and location.
      const own = Array.isArray(op.parameters) ? (op.parameters as Array<Record<string, unknown>>) : [];
      const merged = [...shared.filter((p) => !own.some((o) => o.name === p.name && o.in === p.in)), ...own].filter(isRecord);

      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      const parameters: OperationParameter[] = [];
      let problem: string | undefined;
      for (const parameter of merged) {
        const location = parameter.in;
        const name = String(parameter.name ?? "");
        if (location === "cookie") continue;
        if (location === "header" && TRANSPORT_HEADERS.has(name.toLowerCase())) continue;
        if (location !== "path" && location !== "query" && location !== "header") continue;
        let property = name;
        if (!PROPERTY.test(property) || property in properties || RESERVED.has(property)) property = `${location}_${name}`.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 64);
        if (!PROPERTY.test(property) || property in properties) {
          problem = `parameter '${name}' cannot become an argument name`;
          break;
        }
        const schema = toJsonSchema(isRecord(parameter.schema) ? parameter.schema : { type: "string" }, true) as Record<string, unknown>;
        const description = typeof parameter.description === "string" ? parameter.description : schema.description;
        properties[property] = { ...schema, ...(description ? { description: clip(String(description), MAX_DESCRIPTION) } : {}) };
        const isRequired = location === "path" || parameter.required === true;
        if (isRequired) required.push(property);
        const style = typeof parameter.style === "string" ? parameter.style : location === "query" ? "form" : "simple";
        const explode = typeof parameter.explode === "boolean" ? parameter.explode : style === "form";
        parameters.push({ name, in: location, required: isRequired, property, style, explode });
      }
      if (problem) {
        skip(problem);
        continue;
      }

      let body: Operation["body"];
      const requestBody = isRecord(op.requestBody) ? op.requestBody : undefined;
      if (requestBody && isRecord(requestBody.content)) {
        const contentType = bodyType(requestBody.content);
        if (!contentType) {
          skip(`its body is ${Object.keys(requestBody.content).join(" or ")}, which arguments cannot carry`);
          continue;
        }
        const media = requestBody.content[contentType] as Record<string, unknown>;
        const schema = toJsonSchema(isRecord(media?.schema) ? media.schema : { type: "object" }, true) as Record<string, unknown>;
        const bodyRequired = requestBody.required === true;
        const own = isRecord(schema.properties) ? (schema.properties as Record<string, unknown>) : undefined;
        // Spread a plain object's fields into the input, so a model writes { name, tag } rather than
        // { body: { name, tag } }. A field whose name is taken, by a parameter or by Slipway, is renamed body_<field>.
        const fields: Record<string, string> = {};
        const plain = own !== undefined && (schema.type === "object" || schema.type === undefined) && !schema.allOf && !schema.anyOf && !schema.oneOf && !isRecord(schema.additionalProperties);
        let spreadable = plain;
        for (const field of plain ? Object.keys(own!) : []) {
          let property = field;
          if (!PROPERTY.test(property) || property in properties || RESERVED.has(property)) property = `body_${field}`;
          if (!PROPERTY.test(property) || property in properties || property in fields) {
            spreadable = false;
            break;
          }
          fields[property] = field;
        }
        if (spreadable) {
          for (const [property, field] of Object.entries(fields)) properties[property] = own![field];
          if (bodyRequired && Array.isArray(schema.required)) {
            for (const [property, field] of Object.entries(fields)) if ((schema.required as string[]).includes(field)) required.push(property);
          }
          body = { contentType, required: bodyRequired, spread: true, fields };
        } else {
          if ("body" in properties) {
            skip("a parameter is already named body");
            continue;
          }
          properties.body = { ...schema, description: clip(String(schema.description ?? requestBody.description ?? "The request body."), MAX_DESCRIPTION) };
          if (bodyRequired) required.push("body");
          body = { contentType, required: bodyRequired, spread: false, fields: { body: "body" } };
        }
      }

      let output: JsonSchema | undefined;
      if (options.typedOutput && isRecord(op.responses)) {
        const success = Object.entries(op.responses).find(([status]) => /^2(\d\d|XX)$/i.test(status));
        const content = success && isRecord(success[1]) && isRecord(success[1].content) ? (success[1].content as Record<string, unknown>) : undefined;
        const type = content ? Object.keys(content).find((name) => /json/i.test(name)) : undefined;
        const schema = type && isRecord(content![type]) ? (content![type] as Record<string, unknown>).schema : undefined;
        if (isRecord(schema)) output = toJsonSchema(schema, false) as JsonSchema;
      }

      operations.push({
        operationId,
        method: verb,
        path,
        ...(typeof op.summary === "string" ? { summary: op.summary } : {}),
        ...(typeof op.description === "string" ? { description: op.description } : {}),
        tags: Array.isArray(op.tags) ? (op.tags as unknown[]).filter((tag): tag is string => typeof tag === "string") : [],
        deprecated: op.deprecated === true,
        parameters,
        ...(body ? { body } : {}),
        input: { type: "object", properties, ...(required.length ? { required: [...new Set(required)] } : {}), additionalProperties: false },
        ...(output ? { output } : {}),
      });
    }
  }
  return { operations, skipped };
}

/** Split a tool's arguments back into what goes in the path, the query, the headers and the body. */
export function splitInput(operation: Operation, args: Record<string, unknown>): OperationInput {
  const input: OperationInput = { path: {}, query: {}, headers: {} };
  for (const parameter of operation.parameters) {
    const value = args[parameter.property];
    if (value === undefined) continue;
    if (parameter.in === "header") input.headers[parameter.name] = simple(value, parameter.explode);
    else input[parameter.in][parameter.name] = value;
  }
  if (operation.body) {
    if (operation.body.spread) {
      const body: Record<string, unknown> = {};
      for (const [property, field] of Object.entries(operation.body.fields)) if (args[property] !== undefined) body[field] = args[property];
      if (Object.keys(body).length || operation.body.required) input.body = body;
    } else if (args.body !== undefined) input.body = args.body;
  }
  return input;
}

/** Build a tool for every operation in an OpenAPI 3 document. Throws on a pinned document that changed. */
export function fromOpenAPI<Ctx>(document: unknown, options: FromOpenAPIOptions<Ctx>): Tool<Ctx>[] {
  if (options.pin) {
    const actual = openapiHash(document);
    if (actual !== options.pin.sha256) {
      throw new Error(
        `The OpenAPI document changed since it was pinned: expected sha256 ${options.pin.sha256}, got ${actual}. Review what changed, then update pin.sha256.`,
      );
    }
  }
  const { operations } = readOperations(document, { typedOutput: options.typedOutput === true });
  const include = options.include;
  const chosen = operations.filter((operation) =>
    include === undefined ? true : typeof include === "function" ? include(operation) : include.includes(operation.operationId),
  );
  if (Array.isArray(include)) {
    const missing = include.filter((id) => !operations.some((operation) => operation.operationId === id));
    if (missing.length) throw new Error(`No operations in the document with these ids: ${missing.join(", ")}.`);
  }

  const byName = new Map<string, Operation>();
  const tools = chosen.map((operation) => {
    const name = options.names?.[operation.operationId] ?? toolName(`${options.prefix ?? ""}${options.prefix ? "_" : ""}${operation.operationId}`);
    const clash = byName.get(name);
    if (clash) {
      throw new Error(`Operations ${clash.operationId} and ${operation.operationId} both become the tool ${name}. Name one of them with options.names.`);
    }
    byName.set(name, operation);
    const risk = options.risk?.[operation.operationId] ?? (READS.has(operation.method) ? "read" : operation.method === "DELETE" ? "destructive" : "write");
    const summary = operation.summary?.trim();
    const about = [operation.deprecated ? "Deprecated." : "", summary ?? "", operation.description && operation.description.trim() !== summary ? operation.description : ""]
      .filter(Boolean)
      .join(" ");
    return defineTool<Ctx>({
      name,
      title: clip(summary || words(operation.operationId), 60),
      description: clip(about || `${operation.method} ${operation.path}`, MAX_DESCRIPTION),
      input: jsonSchema(operation.input),
      ...(operation.output ? { output: jsonSchema(operation.output) } : {}),
      risk,
      tags: [...new Set(operation.tags.map(slug).filter((tag) => /^[a-z0-9][a-z0-9-]*$/.test(tag)))],
      summary: (args: Record<string, unknown>) => {
        const shown = operation.parameters.filter((parameter) => parameter.in === "path").map((parameter) => String(args[parameter.property]));
        return `${operation.method} ${operation.path}${shown.length ? ` (${shown.join(", ")})` : ""}`;
      },
      handler: (args: Record<string, unknown>, ctx: ToolContext<Ctx>) => options.execute(operation, splitInput(operation, args), ctx),
    } as never);
  });
  return tools;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * A query parameter written the way its document says. OpenAPI's default,
 * form with explode, repeats a key for each list item and spreads an object's
 * fields into parameters of their own; deepObject writes `key[field]`.
 */
function appendQuery(params: URLSearchParams, parameter: OperationParameter, value: unknown): void {
  if (value === undefined || value === null) return;
  const key = parameter.name;
  if (Array.isArray(value)) {
    if (parameter.explode) for (const item of value) params.append(key, String(item));
    else params.append(key, value.map(String).join(parameter.style === "spaceDelimited" ? " " : parameter.style === "pipeDelimited" ? "|" : ","));
  } else if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, inner]) => inner !== undefined && inner !== null);
    if (parameter.style === "deepObject") for (const [field, inner] of entries) params.append(`${key}[${field}]`, typeof inner === "object" ? JSON.stringify(inner) : String(inner));
    else if (parameter.explode) for (const [field, inner] of entries) params.append(field, String(inner));
    else params.append(key, entries.flatMap(([field, inner]) => [field, String(inner)]).join(","));
  } else params.append(key, String(value));
}

/** A path or header value in OpenAPI's simple style: lists and objects joined with commas. */
function simple(value: unknown, explode: boolean): string {
  if (Array.isArray(value)) return value.map(String).join(",");
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).map(([field, inner]) => (explode ? `${field}=${String(inner)}` : `${field},${String(inner)}`)).join(",");
  }
  return String(value);
}

/** A form body, with nested objects and lists in the bracket style form APIs read: `metadata[plan]=pro`, `items[0][price]=...`. */
export function formEncode(body: unknown): string {
  const params = new URLSearchParams();
  const visit = (prefix: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((item, i) => visit(`${prefix}[${i}]`, item));
    else if (typeof value === "object") for (const [key, inner] of Object.entries(value)) visit(prefix ? `${prefix}[${key}]` : key, inner);
    else params.append(prefix, String(value));
  };
  visit("", body);
  return params.toString();
}

/** What an API said went wrong, from the fields error bodies usually carry. */
function errorMessage(data: unknown): string | undefined {
  if (typeof data === "string") return data.trim().slice(0, 500) || undefined;
  if (!isRecord(data)) return undefined;
  const error = data.error;
  const candidates = [
    data.message,
    isRecord(error) ? error.message : error,
    data.detail,
    data.title,
    Array.isArray(data.errors) && isRecord(data.errors[0]) ? data.errors[0].message : undefined,
  ];
  const found = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
  return found ? String(found).slice(0, 500) : undefined;
}

export type HttpExecutorOptions<Ctx> = {
  /** Where the API lives: https://api.example.com/v1. Plain http only reaches this machine. */
  baseUrl: string | ((ctx: ToolContext<Ctx>) => string);
  /** Headers every call sends, such as the credentials. Register those as secrets on the app, so they are masked. */
  headers?: (ctx: ToolContext<Ctx>) => Record<string, string | undefined> | Promise<Record<string, string | undefined>>;
  fetch?: typeof fetch;
};

/**
 * Calls the API over HTTP. Errors come back as Slipway errors with the API's
 * own message and status, so a model can act on a 404 or a 429 like any other.
 */
export function httpExecutor<Ctx>(options: HttpExecutorOptions<Ctx>): Executor<Ctx> {
  return async (operation, input, ctx) => {
    const base = typeof options.baseUrl === "function" ? options.baseUrl(ctx) : options.baseUrl;
    const root = new URL(base);
    if (root.protocol !== "https:" && !(root.protocol === "http:" && LOOPBACK.has(root.hostname))) {
      throw new UsageError(`Refusing to call ${root.origin}: only https, or http to this machine, carries credentials safely.`);
    }
    const byName = new Map(operation.parameters.map((parameter) => [`${parameter.in}:${parameter.name}`, parameter]));
    const path = operation.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
      const value = input.path[name];
      if (value === undefined || value === null || value === "") throw new UsageError(`${operation.operationId} needs the path parameter ${name}.`);
      return simple(value, byName.get(`path:${name}`)?.explode ?? false).split(",").map(encodeURIComponent).join(",");
    });
    const url = new URL(`${root.href.replace(/\/+$/, "")}${path}`);
    for (const [name, value] of Object.entries(input.query)) {
      appendQuery(url.searchParams, byName.get(`query:${name}`) ?? { name, in: "query", required: false, property: name, style: "form", explode: true }, value);
    }

    const headers = new Headers({ accept: "application/json" });
    for (const [key, value] of Object.entries(input.headers)) headers.set(key, value);
    for (const [key, value] of Object.entries((await options.headers?.(ctx)) ?? {})) if (value !== undefined) headers.set(key, value);
    let body: string | undefined;
    if (input.body !== undefined) {
      const form = /x-www-form-urlencoded/i.test(operation.body?.contentType ?? "");
      body = form ? formEncode(input.body) : JSON.stringify(input.body);
      headers.set("content-type", form ? "application/x-www-form-urlencoded" : "application/json");
    }

    const response = await (options.fetch ?? fetch)(url, { method: operation.method, headers, ...(body === undefined ? {} : { body }), signal: ctx.signal });
    const text = await response.text();
    let data: unknown = text;
    if (/json/i.test(response.headers.get("content-type") ?? "") || /^[[{]/.test(text.trim())) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!response.ok) {
      const retry = Number(response.headers.get("retry-after"));
      throw httpError(response.status, errorMessage(data) ?? `${operation.method} ${operation.path} failed: ${response.status} ${response.statusText}`.trim(), {
        details: data,
        ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: retry } : {}),
      });
    }
    if (text.trim() === "") return { ok: true, status: response.status };
    return data;
  };
}
