/**
 * Flags derived from the JSON Schema an MCP client receives.
 *
 * The terminal and the model read the same schema, so a flag cannot exist on
 * one surface and not the other, and its help text is the description the
 * model reads.
 */

import { readFileSync } from "node:fs";
import { UsageError } from "../errors.js";
import { resolveLocalRef, type JsonSchema } from "../schema.js";
import { didYouMean } from "../search.js";

export type FlagKind = "string" | "number" | "integer" | "boolean" | "enum" | "json";

export type Flag = {
  /** The property name: `reply_to`. */
  key: string;
  /** The long flag: `--reply-to`. */
  flag: string;
  kind: FlagKind;
  required: boolean;
  repeatable: boolean;
  choices?: string[];
  help: string;
  default?: unknown;
};

type Node = {
  $ref?: string;
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  const?: unknown;
  items?: Node;
  properties?: Record<string, Node>;
  anyOf?: Node[];
  oneOf?: Node[];
  default?: unknown;
};

/** The first concrete type, looking through references, nullable unions and type lists. */
function concrete(raw: Node, root: JsonSchema): Node {
  const node = resolveLocalRef(root, raw);
  const union = node.anyOf ?? node.oneOf;
  if (union) {
    const options = union.map((option) => resolveLocalRef(root, option)).filter((option) => option.type !== "null");
    // A union of plain literals is an enum in disguise, which a person types as a word.
    if (options.length > 1 && options.every((option) => option.const !== undefined)) {
      return { ...node, enum: options.map((option) => option.const) };
    }
    return concrete({ ...(options[0] ?? {}), description: node.description ?? options[0]?.description }, root);
  }
  if (Array.isArray(node.type)) return { ...node, type: node.type.find((type) => type !== "null") ?? "string" };
  return node;
}

function kindOf(node: Node, root: JsonSchema): { kind: FlagKind; repeatable: boolean; choices?: string[] } {
  const n = concrete(node, root);
  if (n.enum) return { kind: "enum", repeatable: false, choices: n.enum.map(String) };
  if (n.type === "array") {
    const item = concrete(n.items ?? {}, root);
    if (item.enum) return { kind: "enum", repeatable: true, choices: item.enum.map(String) };
    if (item.type === "object" || item.type === "array") return { kind: "json", repeatable: true };
    if (item.type === "number" || item.type === "integer" || item.type === "boolean") return { kind: item.type, repeatable: true };
    return { kind: "string", repeatable: true };
  }
  if (n.type === "object") return { kind: "json", repeatable: false };
  if (n.type === "number" || n.type === "integer" || n.type === "boolean") return { kind: n.type, repeatable: false };
  return { kind: "string", repeatable: false };
}

export function flagName(key: string): string {
  return `--${key.replace(/_/g, "-")}`;
}

export function flagsFor(schema: JsonSchema): Flag[] {
  const properties = (schema.properties as Record<string, Node> | undefined) ?? {};
  const required = new Set((schema.required as string[] | undefined) ?? []);
  return Object.entries(properties).map(([key, node]) => {
    const n = concrete(node, schema);
    return {
      key,
      flag: flagName(key),
      ...kindOf(node, schema),
      required: required.has(key),
      help: (node.description ?? n.description ?? "").trim(),
      ...(node.default !== undefined ? { default: node.default } : n.default !== undefined ? { default: n.default } : {}),
    };
  });
}

function coerce(flag: Flag, raw: string): unknown {
  switch (flag.kind) {
    case "number":
    case "integer": {
      const value = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(value) || (flag.kind === "integer" && !Number.isInteger(value))) {
        throw new UsageError(`${flag.flag} expects ${flag.kind === "integer" ? "a whole number" : "a number"}, got '${raw}'.`);
      }
      return value;
    }
    case "boolean":
      if (/^(true|1|yes)$/i.test(raw)) return true;
      if (/^(false|0|no)$/i.test(raw)) return false;
      throw new UsageError(`${flag.flag} expects true or false, got '${raw}'.`);
    case "enum":
      if (flag.choices && !flag.choices.includes(raw)) {
        throw new UsageError(`${flag.flag} expects one of: ${flag.choices.join(", ")}. Got '${raw}'.`);
      }
      return raw;
    case "json":
      return parseJsonValue(raw, flag.flag);
    default:
      return raw;
  }
}

/** JSON inline, or `@path` to read it from a file, which spares a person quoting a large body. */
export function parseJsonValue(raw: string, label: string): unknown {
  let text = raw;
  if (raw.startsWith("@") && raw.length > 1) {
    try {
      text = readFileSync(raw.slice(1), "utf8");
    } catch (error) {
      throw new UsageError(`${label} could not read ${raw.slice(1)}: ${(error as Error).message}`);
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(`${label} expects JSON${raw.startsWith("@") ? " in that file" : ""}, got '${text.slice(0, 60)}'.`);
  }
}

/** Lists of numbers and fixed choices may be written once with commas; free text never is, since it may contain commas. */
function splits(flag: Flag): boolean {
  return flag.repeatable && (flag.kind === "enum" || flag.kind === "number" || flag.kind === "integer");
}

/**
 * Parse argv against a tool's flags.
 *
 * Accepts `--flag value`, `--flag=value`, the underscore spelling, `--no-flag`
 * for a boolean, repeated or comma-separated lists, and bare words for the
 * positional arguments. The schema validates the result afterwards; this only
 * gets values into the right types and reports mistakes in terms of flags.
 */
export function parseToolArgs(
  argv: readonly string[],
  flags: readonly Flag[],
  positional: readonly string[],
  aliases: Readonly<Record<string, string>> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const bare: string[] = [];
  const byName = new Map<string, Flag>();
  for (const flag of flags) {
    byName.set(flag.flag, flag);
    byName.set(`--${flag.key}`, flag);
  }
  // An alias never shadows a real flag of the same name.
  for (const [alias, key] of Object.entries(aliases)) {
    const flag = flags.find((candidate) => candidate.key === key);
    if (flag && !byName.has(`--${alias}`)) byName.set(`--${alias}`, flag);
  }

  const assign = (flag: Flag, value: unknown) => {
    if (flag.repeatable) {
      const values = Array.isArray(value) ? value : [value];
      out[flag.key] = [...((out[flag.key] as unknown[] | undefined) ?? []), ...values];
    } else {
      out[flag.key] = value;
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") {
      bare.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith("--") || token === "-") {
      bare.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);
    let flag = byName.get(name);

    if (!flag && name.startsWith("--no-")) {
      const positive = byName.get(`--${name.slice(5)}`);
      if (positive?.kind === "boolean" && eq === -1) {
        assign(positive, false);
        continue;
      }
    }
    if (!flag) {
      const guess = didYouMean(name, flags.map((f) => f.flag));
      throw new UsageError(`Unknown option ${name}.${guess ? ` Did you mean ${guess}?` : ""}`);
    }

    let raw: string | undefined = eq === -1 ? undefined : token.slice(eq + 1);
    if (raw === undefined && flag.kind === "boolean") {
      // A bare boolean is true. Only an explicit true or false after it is
      // taken as its value, so a positional word after a switch is not swallowed.
      const next = argv[i + 1];
      if (next !== undefined && /^(true|false)$/i.test(next)) {
        raw = next;
        i++;
      } else {
        assign(flag, true);
        continue;
      }
    }
    if (raw === undefined) raw = argv[++i];
    if (raw === undefined) throw new UsageError(`${flag.flag} expects a value.`);

    if (splits(flag) && raw.includes(",")) assign(flag, raw.split(",").map((part) => coerce(flag!, part.trim())));
    else assign(flag, coerce(flag, raw));
  }

  if (bare.length > 0) {
    const byKey = new Map(flags.map((flag) => [flag.key, flag]));
    const slots = positional.length > 0 ? positional.map((key) => byKey.get(key)!).filter(Boolean) : [];
    if (slots.length === 0) {
      // With nothing declared, one bare word fills the first required argument,
      // so `search-posts cats` works before anyone reads the help.
      const target = flags.find((flag) => flag.required && out[flag.key] === undefined);
      if (target) slots.push(target);
    }
    for (const [index, word] of bare.entries()) {
      const slot = slots[index];
      if (!slot) throw new UsageError(`Unexpected argument '${word}'.`);
      if (out[slot.key] !== undefined && !slot.repeatable) throw new UsageError(`${slot.flag} was given twice.`);
      assign(slot, coerce(slot, word));
    }
  }

  return out;
}

export function missingRequired(flags: readonly Flag[], args: Record<string, unknown>): Flag[] {
  return flags.filter((flag) => flag.required && args[flag.key] === undefined);
}
