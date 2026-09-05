/**
 * Central typed error classes. Route handlers throw these; they never construct raw
 * HTTP responses for error cases. See docs/15_API_ARCHITECTURE.md and docs/17_BACKEND_ARCHITECTURE.md.
 */

export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly statusCode: number;

  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  readonly code = "VALIDATION_ERROR";
  readonly statusCode = 400;
}

export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND";
  readonly statusCode = 404;
}

export class PermissionError extends AppError {
  readonly code = "PERMISSION_DENIED";
  readonly statusCode = 403;
}

export class RateLimitError extends AppError {
  readonly code = "RATE_LIMITED";
  readonly statusCode = 429;
}

export class ProviderError extends AppError {
  readonly code = "PROVIDER_ERROR";
  readonly statusCode = 502;
}

/** A required backing service is not configured/available and the operation cannot be
 * performed safely without it — e.g. an upload when UPLOAD_SCAN_REQUIRED=true but no malware
 * scanner is configured (docs/26_DECISIONS.md ADR-042). 503, not 500: it is an operator
 * configuration state, not an unexpected failure, and clients may retry later. */
export class ServiceUnavailableError extends AppError {
  readonly code = "SERVICE_UNAVAILABLE";
  readonly statusCode = 503;
}

/** FR-063 (docs/22_COST_AND_QUOTA_STRATEGY.md) — a configured usage quota would be
 * exceeded by this request. Distinct from RateLimitError: that's a per-time-window request
 * throttle (docs/26_DECISIONS.md ADR-032); this is a usage-budget check. */
export class QuotaExceededError extends AppError {
  readonly code = "QUOTA_EXCEEDED";
  readonly statusCode = 429;
}

/** The caller did not prove who they are (missing/invalid/expired credential). Distinct from
 * PermissionError: 401 means "authenticate", 403 means "authenticated but not allowed"
 * (docs/13_SECURITY_ARCHITECTURE.md §2, ADR-049). */
export class UnauthorizedError extends AppError {
  readonly code = "UNAUTHORIZED";
  readonly statusCode = 401;
}

/** A write lost an optimistic-concurrency race, or a uniqueness constraint was violated by a
 * concurrent request. Retryable by the client with fresh state. */
export class ConflictError extends AppError {
  readonly code = "CONFLICT";
  readonly statusCode = 409;
}

/** The request was well-formed and authorized, but the platform cannot do it with the
 * providers actually configured — e.g. real image generation with no image provider. Never
 * substituted with a fake success (ADR-050). */
export class CapabilityUnavailableError extends AppError {
  readonly code = "CAPABILITY_UNAVAILABLE";
  readonly statusCode = 501;
}
