/** Operational error: rendered as `{ "error": "<CODE>", "message"?: string, "details"?: unknown }` with `status`. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    public readonly details?: unknown,
    public readonly headers?: Record<string, string>,
  ) {
    super(message ?? code);
    this.name = 'ApiError';
  }
  static badRequest(code = 'BAD_REQUEST', message?: string, details?: unknown) { return new ApiError(400, code, message, details); }
  static unauthorized(code = 'UNAUTHORIZED', message?: string) { return new ApiError(401, code, message); }
  static forbidden(code = 'FORBIDDEN', message?: string) { return new ApiError(403, code, message); }
  static notFound(code = 'NOT_FOUND', message?: string) { return new ApiError(404, code, message); }
  static conflict(code = 'CONFLICT', message?: string) { return new ApiError(409, code, message); }
  static tooMany(code = 'TOO_MANY_REQUESTS', message?: string, retryAfterSeconds?: number, details?: unknown) {
    return new ApiError(429, code, message, details, retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : undefined);
  }
}
