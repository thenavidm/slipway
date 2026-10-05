/**
 * Finding the tool for a task by what it does, not by its name.
 *
 * A server with a hundred tools is only usable when the right one can be found
 * from the words someone would use to ask for it. The same ranking answers
 * `which` in a terminal and `search_tools` for a model.
 */

import type { Tool } from "./tool.js";

export type Match = { tool: Tool; score: number };

/** Words a query carries that say nothing about which tool: "how do I get my images". */
const STOP_WORDS = new Set([
  "the", "my", "me", "to", "of", "for", "in", "on", "and", "or", "how", "do", "does", "can", "want",
  "with", "from", "is", "are", "it", "that", "this", "what", "which", "any", "some", "please", "an",
]);

function words(text: string): string[] {
  return text
    // camelCase splits, so `channelId` reads as "channel id" and `createPost` as "create post".
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1)
    .map(stem);
}

function queryWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
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

function hits(query: string, haystack: string[], extra?: ReadonlyMap<string, string[]>): number {
  const direct = exact(query, haystack);
  if (direct > 0) return direct;
  // A synonym counts for a little less than the word itself, so an exact match still wins.
  const related = [...(RELATED.get(query) ?? []), ...(extra?.get(query) ?? [])];
  return related.some((word) => word !== query && exact(word, haystack) === 1) ? 0.75 : 0;
}

function exact(query: string, haystack: string[]): number {
  if (haystack.includes(query)) return 1;
  return haystack.some((word) => word.startsWith(query) || query.startsWith(word)) ? 0.5 : 0;
}

export function searchTools(tools: readonly Tool[], query: string, limit = 10, synonyms: Readonly<Record<string, readonly string[]>> = {}): Match[] {
  const terms = [...new Set(queryWords(query))];
  if (terms.length === 0) return [];
  const phrase = query.trim().toLowerCase();
  const extra = new Map<string, string[]>();
  const pointsAt = new Map<string, string[]>();
  for (const [word, targets] of Object.entries(synonyms)) {
    extra.set(stem(word.toLowerCase()), targets.flatMap(words));
    pointsAt.set(stem(word.toLowerCase()), targets.map((target) => target.toLowerCase()));
  }
  // A synonym can point straight at a tool's name, "redo" at `rerun_job`.
  const named = (tool: Tool, term: string) =>
    [term, ...(pointsAt.get(term) ?? [])].some((word) => word === tool.name || word === tool.name.replace(/_/g, ""));

  const scored = tools.map((tool) => {
    const name = words(tool.name);
    const title = words(tool.title);
    const tags = tool.tags.flatMap(words);
    const description = words(tool.description);
    // What a tool takes says what it is for: `channelId` and `schedulingType` find the post tool for "schedule a post to a channel".
    // Only the words themselves count there. Through a synonym, Google Photos' "photos" read as `media_item_id`
    // and put get_media_item level with the picker for "let me choose photos".
    const args = Object.keys((tool.jsonSchema.properties as Record<string, unknown> | undefined) ?? {}).filter((key) => key !== "confirm").flatMap(words);
    let score = 0;
    let matched = 0;
    for (const term of terms) {
      // A term that is the tool's name is not a hint, it is the answer.
      const got = (named(tool, term) ? 20 : 0) + hits(term, name, extra) * 5 + hits(term, title, extra) * 4 + hits(term, tags, extra) * 3 + exact(term, args) * 2 + hits(term, description, extra);
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
