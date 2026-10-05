/**
 * How a result is printed.
 *
 * A person reads text, a script reads JSON, a spreadsheet reads CSV, and a
 * model reads whatever costs it least. One result, several shapes, chosen by a
 * flag, never by guessing at what the reader is.
 */

import type { ContentBlock } from "@modelcontextprotocol/server";
import { getPath } from "../pages.js";
import { isContentResult } from "../result.js";
import type { Tool } from "../tool.js";

export type Format = "auto" | "json" | "compact" | "jsonl" | "csv" | "tsv" | "quiet";

export type OutputOptions = { format: Format; select?: string[] };

/**
 * `--select a,b.c` keeps only those fields. Dotted paths descend, arrays are
 * walked element by element, which is what makes a long listing affordable.
 */
export function selectFields(data: unknown, paths: readonly string[]): unknown {
  if (Array.isArray(data)) return data.map((item) => selectFields(item, paths));
  if (data === null || typeof data !== "object") return data;
  const record = data as Record<string, unknown>;
  // `--select id,status` on `{ count, jobs: [...] }` means the jobs' fields. When no path
  // starts at the top and the result holds one list of records, select inside it and keep
  // the rest as it is. A list of plain values, such as image URLs, is not a result set.
  const heads = paths.map((path) => path.split(".")[0]).filter((head): head is string => Boolean(head));
  if (heads.length && heads.every((head) => !(head in record))) {
    const isRecord = (item: unknown) => item !== null && typeof item === "object" && !Array.isArray(item);
    const arrays = Object.entries(record).filter(([, value]) => Array.isArray(value)) as Array<[string, unknown[]]>;
    const lists = arrays.filter(([, value]) => value.length > 0 && value.every(isRecord));
    const only = lists.length === 1 ? lists[0] : lists.length === 0 && arrays.length === 1 && arrays[0]![1].length === 0 ? arrays[0] : undefined;
    if (only) return { ...record, [only[0]]: only[1].map((item) => selectFields(item, paths)) };
  }
  // Grouped by first segment: assigning one path at a time let the last path win,
  // so `--select posts.uri,posts.text` returned only the text.
  const byHead = new Map<string, string[]>();
  for (const path of paths) {
    const [head, ...rest] = path.split(".");
    if (!head) continue;
    const group = byHead.get(head) ?? [];
    if (rest.length) group.push(rest.join("."));
    byHead.set(head, group);
  }
  const out: Record<string, unknown> = {};
  for (const [head, rest] of byHead) {
    const value = (data as Record<string, unknown>)[head];
    if (value === undefined) continue;
    out[head] = rest.length ? selectFields(value, rest) : value;
  }
  return out;
}


function describePart(part: ContentBlock): string {
  if (part.type === "text") return (part as { text: string }).text;
  const p = part as { type: string; mimeType?: string; data?: string; uri?: string; resource?: { uri?: string; mimeType?: string; blob?: string } };
  const size = p.data ?? p.resource?.blob;
  const kb = size ? `, ${Math.max(1, Math.round((size.length * 3) / 4 / 1024))} KB` : "";
  const where = p.uri ?? p.resource?.uri;
  return `[${p.type}${p.mimeType ?? p.resource?.mimeType ? ` ${p.mimeType ?? p.resource?.mimeType}` : ""}${kb}${where ? ` ${where}` : ""}]`;
}

/** What a result is as data: a content result's data, or its parts described in words. */
export function terminalData(value: unknown): unknown {
  if (!isContentResult(value)) return value;
  if (value.data !== undefined) return value.data;
  return value.parts.map(describePart).join("\n");
}

function cell(value: unknown, separator: string): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (separator === "\t") return text.replace(/[\t\n\r]+/g, " ");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function table(data: unknown, separator: string): string {
  if (Array.isArray(data)) {
    if (data.every((row) => row === null || typeof row !== "object" || Array.isArray(row))) {
      return data.map((row) => cell(row, separator)).join("\n");
    }
    const columns: string[] = [];
    for (const row of data) {
      if (row && typeof row === "object") for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
    }
    const lines = [columns.map((column) => cell(column, separator)).join(separator)];
    for (const row of data) {
      lines.push(columns.map((column) => cell((row as Record<string, unknown>)?.[column], separator)).join(separator));
    }
    return lines.join("\n");
  }
  if (data !== null && typeof data === "object") {
    // A single array field is the listing a person meant to tabulate.
    const arrays = Object.entries(data).filter(([, value]) => Array.isArray(value));
    if (arrays.length === 1) return table(arrays[0]![1], separator);
    return Object.entries(data)
      .map(([key, value]) => `${cell(key, separator)}${separator}${cell(value, separator)}`)
      .join("\n");
  }
  return cell(data, separator);
}

/**
 * The one list inside a wrapper like `{ items, cursor }`, which is what a person
 * means when they ask for lines or rows of a result that is not itself a list.
 */
function singleList(data: unknown): unknown[] | undefined {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const arrays = Object.values(data).filter(Array.isArray);
  return arrays.length === 1 ? (arrays[0] as unknown[]) : undefined;
}

const IDENTIFIERS = ["id", "uri", "url", "name", "handle", "slug", "key"];

function quiet(data: unknown, select?: readonly string[]): string {
  const pick = (item: unknown): string => {
    if (item === null || typeof item !== "object") return String(item ?? "");
    if (select?.length === 1) return String(getPath(item, select[0]!) ?? "");
    const key = IDENTIFIERS.find((candidate) => (item as Record<string, unknown>)[candidate] !== undefined);
    return key ? String((item as Record<string, unknown>)[key]) : JSON.stringify(item);
  };
  if (Array.isArray(data)) return data.map(pick).join("\n");
  if (data !== null && typeof data === "object") {
    const arrays = Object.values(data).filter(Array.isArray);
    if (arrays.length === 1) return (arrays[0] as unknown[]).map(pick).join("\n");
  }
  return pick(data);
}

/** Render a result for stdout. Always ends with a newline. */
export function formatOutput(value: unknown, tool: Tool | undefined, options: OutputOptions): string {
  let data = terminalData(value);
  if (options.select?.length && data !== null && typeof data === "object") data = selectFields(data, options.select);

  let text: string;
  switch (options.format) {
    case "json":
      text = JSON.stringify(data, null, 2) ?? "null";
      break;
    case "compact":
      text = JSON.stringify(data) ?? "null";
      break;
    case "jsonl": {
      const list = Array.isArray(data) ? data : singleList(data);
      text = list ? list.map((item) => JSON.stringify(item)).join("\n") : (JSON.stringify(data) ?? "null");
      break;
    }
    case "csv":
      text = table(data, ",");
      break;
    case "tsv":
      text = table(data, "\t");
      break;
    case "quiet":
      text = quiet(data, options.select);
      break;
    default:
      if (typeof data === "string") text = data;
      else if (tool?.render && !options.select?.length && data !== undefined) text = tool.render(data);
      else text = JSON.stringify(data, null, 2) ?? "null";
  }
  return text.endsWith("\n") ? text : `${text}\n`;
}
