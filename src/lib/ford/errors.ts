/*
 * Error classes of the Ford client. Messages never contain client secret, tokens, the
 * authorization code, the VIN or a URL.
 */

/** Base class of all Ford errors */
export class FordApiError extends Error {
    /**
     * @param message - Message without secrets
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
export class FordNetworkError extends FordApiError {}

/** Login needed (no token, refresh token rejected or expired) - only the user can fix this in the browser */
export class FordLoginRequiredError extends FordApiError {}

/** Client ID / secret rejected - check the app in the Ford developer portal */
export class FordClientRejectedError extends FordApiError {}

/** HTTP 429; waitMs = how long to pause */
export class FordRateLimitedError extends FordApiError {
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
export class FordResponseError extends FordApiError {}

/** Request cancelled because the adapter is shutting down */
export class FordAbortedError extends FordApiError {}
