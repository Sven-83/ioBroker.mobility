/*
 * Error classes of the Tankerkoenig client. main.ts / the fuel service decide on retries by class.
 * Messages never contain the API key or the request URL (the key is a query parameter there).
 */

/** Base class of all Tankerkoenig errors */
export class FuelApiError extends Error {
    /**
     * @param message - Message without key or URL
     * @param status - HTTP status, if there was an answer
     */
    public constructor(
        message: string,
        public readonly status?: number,
    ) {
        super(message);
        this.name = new.target.name;
    }
}

/** No answer (DNS, connection, timeout) */
export class FuelNetworkError extends FuelApiError {}

/** The service rejected the API key - retrying does not help until the config changes */
export class FuelKeyRejectedError extends FuelApiError {}

/** HTTP 429 or a "too many requests" message; waitMs = how long to pause */
export class FuelRateLimitedError extends FuelApiError {
    /**
     * @param message - Message
     * @param waitMs - Pause before the next request
     */
    public constructor(
        message: string,
        public readonly waitMs: number,
    ) {
        super(message, 429);
    }
}

/** Unexpected answer (HTTP error, invalid JSON) */
export class FuelResponseError extends FuelApiError {}

/**
 * The API answered ok:false for another reason than the key. Tankerkoenig: "always check ok;
 * if false, the reason is in message and no further requests should follow" -> long pause.
 */
export class FuelRefusedError extends FuelApiError {}

/** Request cancelled because the adapter is shutting down */
export class FuelAbortedError extends FuelApiError {}

/**
 * Short text for log messages.
 *
 * @param error - Anything thrown
 */
export function describeError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
