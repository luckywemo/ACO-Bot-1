export class OpenSeaApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `OpenSea API ${status} on ${path}`);
    this.name = "OpenSeaApiError";
  }

  /** 429 and 5xx are safe to retry with backoff. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }

  /** 409 (not active) / 422 (precondition: allowlist, limits, supply). */
  get notEligible(): boolean {
    return this.status === 409 || this.status === 422;
  }
}

export function extractApiErrors(body: unknown): string | undefined {
  if (
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as { errors?: unknown }).errors)
  ) {
    return (body as { errors: unknown[] }).errors.map(String).join("; ");
  }
  return undefined;
}
