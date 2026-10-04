/**
 * Finding the tool for a task by what it does, not by its name.
 *
 * A server with a hundred tools is only usable when the right one can be found
 * from the words someone would use to ask for it. The same ranking answers
 * `which` in a terminal and `search_tools` for a model.
 */

import type { Tool } from "./tool.js";

export type Match = { tool: Tool; score: number };

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1)
    .map(stem);
}

/** Close enough for matching "posts" to "post" and "scheduling" to "schedul". */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

/**
 * Words people use for the same action. Tool names settle on one verb, and the
 * person searching rarely picks the same one: they "remove" what the API calls
 * "delete".
 */
const SYNONYMS: string[][] = [
  ["delete", "remove", "erase", "trash", "destroy", "drop", "unpublish"],
  ["create", "add", "new", "make", "insert", "write"],
  ["update", "edit", "change", "modify", "rename", "set"],
  ["list", "show", "browse", "all", "index", "enumerate"],
  ["get", "read", "fetch", "view", "lookup", "retrieve", "open"],
  ["search", "find", "query", "lookup", "filter"],
  ["send", "email", "message", "notify", "deliver"],
  ["post", "publish", "share", "tweet", "status"],
  ["schedule", "queue", "plan", "later"],
  ["upload", "attach", "import"],
  ["download", "export", "save", "backup"],
  ["stat", "analytic", "metric", "insight", "report", "count"],
  ["user", "member", "account", "person", "contact", "customer", "student", "subscriber"],
].map((group) => group.map(stem));

const RELATED = new Map<string, string[]>();
for (const group of SYNONYMS) for (const word of group) RELATED.set(word, [...new Set([...(RELATED.get(word) ?? []), ...group])]);

function hits(query: string, haystack: string[]): number {
  const direct = exact(query, haystack);
  if (direct > 0) return direct;
  // A synonym counts for a little less than the word itself, so an exact match still wins.
  return (RELATED.get(query) ?? []).some((word) => word !== query && exact(word, haystack) === 1) ? 0.75 : 0;
}

function exact(query: string, haystack: string[]): number {
  if (haystack.includes(query)) return 1;
  return haystack.some((word) => word.startsWith(query) || query.startsWith(word)) ? 0.5 : 0;
}

export function searchTools(tools: readonly Tool[], query: string, limit = 10): Match[] {
  const terms = [...new Set(words(query))];
  if (terms.length === 0) return [];
  const phrase = query.trim().toLowerCase();

  const scored = tools.map((tool) => {
    const name = words(tool.name);
    const title = words(tool.title);
    const tags = tool.tags.flatMap(words);
    const description = words(tool.description);
    let score = 0;
    let matched = 0;
    for (const term of terms) {
      const got = hits(term, name) * 5 + hits(term, title) * 4 + hits(term, tags) * 3 + hits(term, description);
      if (got > 0) matched++;
      score += got;
    }
    // A tool that matches every word beats one that matches one word strongly.
    score *= matched / terms.length;
    if (phrase.length > 3 && (tool.title.toLowerCase().includes(phrase) || tool.description.toLowerCase().includes(phrase))) score += 3;
    return { tool, score };
  });

  return scored
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit);
}

/** Edit distance, for "did you mean" on a mistyped command. */
export function distance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i]![j] = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
    }
  }
  return rows[a.length]![b.length]!;
}

export function didYouMean(input: string, candidates: readonly string[]): string | undefined {
  const target = input.toLowerCase();
  let best: { candidate: string; score: number } | undefined;
  for (const candidate of candidates) {
    const score = candidate.startsWith(target) ? 0 : distance(target, candidate);
    if (score <= Math.max(2, Math.floor(target.length / 4)) && (!best || score < best.score)) best = { candidate, score };
  }
  return best?.candidate;
}

/** The first sentence of a description, for one-line listings. */
export function firstSentence(text: string, max = 100): string {
  const first = text.trim().split(/(?<=[.!?])\s/)[0] ?? "";
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}
