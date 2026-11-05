/*
 * Error classes of the Easee client. The service decides on retries by class.
 * Messages never contain the password, tokens, the serial number or the request URL.
 */

/** Base class of all Easee errors */
export class EaseeApiError extends Error {
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
export class EaseeNetworkError extends EaseeApiError {}

/** Login rejected (user name / password) - retrying would only risk a lock of the account */
export class EaseeAuthError extends EaseeApiError {}

/** HTTP 429; waitMs = how long to pause */
export class EaseeRateLimitedError extends EaseeApiError {
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

/** Unexpected answer (HTTP error, invalid JSON, unknown charger) */
export class EaseeResponseError extends EaseeApiError {}

/** Request cancelled because the adapter is shutting down */
export class EaseeAbortedError extends EaseeApiError {}
