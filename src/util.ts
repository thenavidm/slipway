/**
 * Small helpers more than one module needs.
 */

import { createHash } from "node:crypto";

/** JSON with object keys sorted at every depth, so equal values always serialize the same. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  ) ?? "null";
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** "2.1.286" as numbers, ignoring anything after the first non-numeric part. */
export function versionParts(version: string | undefined): number[] {
  const match = /^v?(\d+(?:\.\d+)*)/.exec(version?.trim() ?? "");
  return match ? match[1]!.split(".").map(Number) : [];
}

/** Whether `version` is at least `minimum`. An unreadable version is never at least anything. */
export function versionAtLeast(version: string | undefined, minimum: readonly number[]): boolean {
  const parts = versionParts(version);
  if (parts.length === 0) return false;
  for (let i = 0; i < minimum.length; i++) {
    const have = parts[i] ?? 0;
    if (have !== minimum[i]) return have > minimum[i]!;
  }
  return true;
}

/** A title or summary as it reads mid-sentence: "Delete a course" becomes "delete a course", "GitHub issue" keeps its capitals. */
export function phrase(text: string): string {
  const trimmed = text.trim().replace(/[.!?]+$/, "");
  return /^[A-Z][a-z]/.test(trimmed) && !/^[A-Z][a-z]+[A-Z]/.test(trimmed) ? trimmed.charAt(0).toLowerCase() + trimmed.slice(1) : trimmed;
}
