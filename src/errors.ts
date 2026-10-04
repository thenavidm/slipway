/**
 * Errors that carry their own exit code.
 *
 * A script branches on the number, a model reads the message and the hint.
 * Mapping errors to exit codes by matching words in the message breaks the day
 * someone rewords a message, so every error Slipway raises says which code it
 * is, and the word matching survives only as a fallback for errors thrown by
 * code that knows nothing about Slipway.
 */

/** The exit-code contract. Scripts depend on these numbers, so they never change. */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  notFound: 3,
  auth: 4,
  api: 5,
  rateLimited: 7,
  notConfigured: 10,
  interrupted: 130,
} as const;

export type ErrorCode =
  | "usage"
  | "refused"
  | "not_found"
  | "auth"
  | "api"
  | "rate_limited"
  | "not_configured"
  | "timeout"
  | "canceled"
  | "internal";

export type ErrorOptions = {
  hint?: string;
  status?: number;
  retryAfterSeconds?: number;
  details?: unknown;
  cause?: unknown;
};

export type ErrorPayload = {
  error: string;
  code: ErrorCode;
  hint?: string;
  status?: number;
  retry_after_seconds?: number;
  details?: unknown;
};

export class SlipwayError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;
  readonly hint?: string;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  readonly details?: unknown;

  constructor(message: string, code: ErrorCode, exitCode: number, options: ErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.exitCode = exitCode;
    this.hint = options.hint;
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.details = options.details;
  }

  /** The one shape both surfaces report: JSON on stderr in a terminal, an isError result over MCP. */
  toJSON(): ErrorPayload {
    const payload: ErrorPayload = { error: this.message, code: this.code };
    if (this.hint) payload.hint = this.hint;
    if (this.status !== undefined) payload.status = this.status;
    if (this.retryAfterSeconds !== undefined) payload.retry_after_seconds = this.retryAfterSeconds;
    if (this.details !== undefined) payload.details = this.details;
    return payload;
  }
}

/** The caller asked for something malformed. Fix the arguments and retry. */
export class UsageError extends SlipwayError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "usage", EXIT.usage, options);
  }
}

/** A write the guard would not run: read-only mode, destructive writes off, or no confirmation. */
export class RefusedError extends SlipwayError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "refused", EXIT.usage, options);
  }
}

export class NotFoundError extends SlipwayError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "not_found", EXIT.notFound, options);
  }
}

export class AuthError extends SlipwayError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "auth", EXIT.auth, options);
  }
}

export class ApiError extends SlipwayError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "api", EXIT.api, options);
  }
}

export class RateLimitError extends SlipwayError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "rate_limited", EXIT.rateLimited, options);
  }
}

/**
 * Nothing is set up yet. This is what someone hits on first run, so it always
 * names the command that fixes it.
 */
export class NotConfiguredError extends SlipwayError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "not_configured", EXIT.notConfigured, options);
  }
}

export class TimeoutError extends SlipwayError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "timeout", EXIT.api, options);
  }
}

export class CanceledError extends SlipwayError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "canceled", EXIT.interrupted, options);
  }
}

/**
 * The error for an HTTP status, so an API client needs one line per failure.
 *
 * 400 and 422 are usage errors: the upstream API rejected the arguments, and the
 * caller fixes that by changing them, exactly like a schema failure.
 */
export function httpError(status: number, message: string, options: ErrorOptions = {}): SlipwayError {
  const withStatus = { ...options, status };
  if (status === 401 || status === 403) return new AuthError(message, withStatus);
  if (status === 404 || status === 410) return new NotFoundError(message, withStatus);
  if (status === 429) return new RateLimitError(message, withStatus);
  if (status === 400 || status === 422) return new UsageError(message, withStatus);
  return new ApiError(message, withStatus);
}

/**
 * Turn anything thrown into a SlipwayError.
 *
 * Errors from other libraries arrive with no code, so the fallback reads the
 * shape they usually have (a numeric `status`, an abort) and only then the
 * words in the message.
 */
export function toSlipwayError(error: unknown): SlipwayError {
  if (error instanceof SlipwayError) return error;

  const e = error as { name?: string; message?: unknown; status?: unknown; statusCode?: unknown } | undefined;
  const message =
    typeof e?.message === "string" && e.message ? e.message : typeof error === "string" ? error : "Unknown error";
  const status =
    typeof e?.status === "number" ? e.status : typeof e?.statusCode === "number" ? e.statusCode : undefined;

  if (e?.name === "AbortError") return new CanceledError(message, { cause: error });
  if (e?.name === "TimeoutError") return new TimeoutError(message, { cause: error });
  if (status !== undefined && status >= 400) return httpError(status, message, { cause: error });

  const text = message.toLowerCase();
  if (/rate ?limit|too many requests|\b429\b/.test(text)) return new RateLimitError(message, { cause: error });
  // Before auth: "no token configured" mentions a token, and matching auth first
  // sends someone who configured nothing looking for a bad credential.
  if (/not configured|nothing is configured|no [a-z ]*(account|credential|token|key)s? (is |are )?(set|configured)/.test(text))
    return new NotConfiguredError(message, { cause: error });
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid[_ ]grant|expired token|token (has )?expired/.test(text))
    return new AuthError(message, { cause: error });
  if (/\b404\b|not found|does not exist/.test(text)) return new NotFoundError(message, { cause: error });
  // A request that never got an answer is the service's failure, not a bug here: exit 5, which a script may retry.
  const codes = [(error as { code?: unknown })?.code, (error as { cause?: { code?: unknown } })?.cause?.code];
  const network = codes.some((code) => typeof code === "string" && /^(ECONN(REFUSED|RESET|ABORTED)|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|E(HOST|NET)UNREACH|EPIPE|UND_ERR_\w+)$/.test(code));
  if (network || /fetch failed|could not reach|network error|socket hang up/.test(text)) return new ApiError(message, { cause: error });
  return new SlipwayError(message, "internal", EXIT.error, { cause: error });
}
