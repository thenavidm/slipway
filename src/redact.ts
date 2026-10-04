/**
 * Keeps credentials out of everything a tool returns.
 *
 * An upstream API will happily echo a key back in an error message or a
 * response body, and from there it lands in a model's context, a terminal
 * scrollback or an audit log. Every result and every error on both surfaces
 * passes through here, so a secret registered once is masked everywhere.
 */

const MASK = "[redacted]";

/** Field names whose values are credentials whatever they contain. */
const SECRET_KEYS =
  /^(authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|password|passwd|secret|client[-_]?secret|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|token|private[-_]?key|session[-_]?token)$/i;

/**
 * Values shorter than this are not masked, because a short "secret" such as a
 * default region code would turn every matching word in a response into noise.
 */
const MIN_LENGTH = 6;

export class Secrets {
  private readonly values = new Set<string>();

  /** Register values that must never appear in output: keys, tokens, passwords. */
  add(...values: Array<string | undefined | null>): void {
    for (const value of values) {
      if (typeof value === "string" && value.length >= MIN_LENGTH) this.values.add(value);
    }
  }

  get size(): number {
    return this.values.size;
  }

  redact(text: string): string {
    let out = text;
    // Longest first, so a secret that contains another is masked whole.
    for (const value of [...this.values].sort((a, b) => b.length - a.length)) {
      if (out.includes(value)) out = out.split(value).join(MASK);
    }
    return out;
  }

  /** Walk a value and mask registered secrets in strings and every credential-named field. */
  redactDeep<T>(value: T): T {
    return this.walk(value, new WeakSet()) as T;
  }

  private walk(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === "string") return this.redact(value);
    if (value === null || typeof value !== "object") return value;
    if (value instanceof Uint8Array) return value;
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => this.walk(item, seen));
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SECRET_KEYS.test(key) && inner !== null && inner !== undefined && inner !== "" ? MASK : this.walk(inner, seen);
    }
    return out;
  }
}
