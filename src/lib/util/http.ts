/*
 * HTTP helpers shared by the cloud clients (Tankerkoenig, Easee, later Ford).
 * Nothing here ever returns a URL, header or body - those may contain keys or tokens.
 */

/** Upper bound for a server-requested wait */
export const MAX_RETRY_AFTER_MS = 3_600_000;

/**
 * Parses a Retry-After header (delay in seconds or HTTP date).
 *
 * @param header - Header value
 * @param now - Current time (epoch ms)
 * @returns Wait time in ms (capped at one hour), undefined if missing or invalid
 */
export function parseRetryAfter(header: string | null, now: number): number | undefined {
    const value = header?.trim();
    if (!value) {
        return undefined;
    }
    const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
    return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS) : undefined;
}

/**
 * Reason of a failed fetch without the URL (undici puts the cause into error.cause).
 *
 * @param error - Thrown by fetch
 */
export function networkReason(error: unknown): string {
    const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
    if (cause && typeof cause.code === 'string') {
        return cause.code;
    }
    if (error instanceof Error && error.name === 'TimeoutError') {
        return 'timeout';
    }
    return (error instanceof Error ? error.message : String(error)).replace(/https?:\/\/\S+/g, '<url>');
}
