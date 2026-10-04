/**
 * Turning what a handler returns into what a client receives.
 *
 * A handler returns plain data. An object goes out twice: as compact JSON text,
 * which every client can show a model, and as `structuredContent`, which a
 * client can use without parsing text. Compact, because the reader of that text
 * is usually a model paying for every character, not a person.
 */

import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/server";
import type { SlipwayError } from "./errors.js";
import type { Secrets } from "./redact.js";
import type { Tool } from "./tool.js";

const CONTENT = Symbol.for("slipway.content");

/** A result that is already content blocks: images, audio, files, links, or several texts. */
export type ContentResult = {
  readonly [CONTENT]: true;
  readonly parts: readonly ContentBlock[];
  /** Typed data to send alongside, and to print in a terminal. */
  readonly data?: unknown;
};

export function content(parts: ContentBlock | readonly ContentBlock[], data?: unknown): ContentResult {
  return { [CONTENT]: true, parts: Array.isArray(parts) ? [...parts] : [parts as ContentBlock], data };
}

export function isContentResult(value: unknown): value is ContentResult {
  return value !== null && typeof value === "object" && (value as Record<symbol, unknown>)[CONTENT] === true;
}

function base64(data: Uint8Array | string): string {
  return typeof data === "string" ? data : Buffer.from(data).toString("base64");
}

/** An image. Pass bytes, or a base64 string you already have. */
export function image(data: Uint8Array | string, mimeType: string): ContentBlock {
  return { type: "image", data: base64(data), mimeType } as ContentBlock;
}

export function audio(data: Uint8Array | string, mimeType: string): ContentBlock {
  return { type: "audio", data: base64(data), mimeType } as ContentBlock;
}

/** A file embedded in the result, for a client that saves or renders it. */
export function file(data: Uint8Array | string, options: { uri: string; mimeType: string }): ContentBlock {
  return { type: "resource", resource: { uri: options.uri, mimeType: options.mimeType, blob: base64(data) } } as ContentBlock;
}

/** A pointer to something the client can fetch, without its bytes in the result. */
export function resourceLink(
  uri: string,
  options: { name: string; title?: string; description?: string; mimeType?: string },
): ContentBlock {
  return { type: "resource_link", uri, ...options } as ContentBlock;
}

export function text(value: string): ContentBlock {
  return { type: "text", text: value } as ContentBlock;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** What a handler returned, as data: the value itself, or a content result's data. */
export function dataOf(value: unknown): unknown {
  return isContentResult(value) ? value.data : value;
}

export function toCallToolResult(tool: Tool, value: unknown, secrets: Secrets): CallToolResult {
  if (isContentResult(value)) {
    const parts = value.parts.map((part) =>
      part.type === "text" ? ({ ...part, text: secrets.redact((part as { text: string }).text) } as ContentBlock) : part,
    );
    const data = secrets.redactDeep(value.data);
    const structured = data !== undefined && (isPlainObject(data) || tool.output !== undefined);
    return structured ? { content: parts, structuredContent: data as Record<string, unknown> } : { content: parts };
  }

  const data = secrets.redactDeep(value);

  if (data === undefined || data === null) {
    return { content: [text("Done.")] };
  }

  const rendered = tool.render ? secrets.redact(tool.render(data)) : undefined;

  if (typeof data === "string") {
    return tool.output
      ? { content: [text(rendered ?? data)], structuredContent: data as never }
      : { content: [text(rendered ?? data)] };
  }

  const body = rendered ?? (typeof data === "object" ? JSON.stringify(data) : String(data));
  // An object is always typed data. Anything else only is when the tool declares
  // an output schema, because the protocol needs a schema to describe it.
  if (isPlainObject(data) || tool.output !== undefined) {
    return { content: [text(body)], structuredContent: data as Record<string, unknown> };
  }
  return { content: [text(body)] };
}

export function errorResult(error: SlipwayError, secrets: Secrets): CallToolResult {
  return { isError: true, content: [text(secrets.redact(JSON.stringify(secrets.redactDeep(error.toJSON()))))] };
}
