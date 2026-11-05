/*
 * Client for the Easee cloud API (api.easee.com), checked against developer.easee.com 2026-11-05:
 *  - POST /api/accounts/login {userName, password} -> {accessToken, expiresIn (s), refreshToken, ...}
 *  - POST /api/accounts/refresh_token {refreshToken} with Bearer access token
 *    (refresh tokens can become invalid on Easee's side -> fall back to a fresh login)
 *  - GET  /api/chargers                         chargers of the account
 *  - GET  /state/{serial}/observations?ids=...  current values, 100 requests / 5 min
 *  - POST /api/chargers/{serial}/commands/{start|stop|pause|resume}_charging
 * The old GET /api/chargers/{id}/state is gone since 2026-09-01 and is not used.
 *
 * Password and tokens live only in memory; no message contains them, the serial or a URL.
 */

import {
    EaseeAbortedError,
    EaseeAuthError,
    EaseeNetworkError,
    EaseeRateLimitedError,
    EaseeResponseError,
} from './errors';
import { OBSERVATION_IDS, type RawObservation } from './observations';
import { networkReason, parseRetryAfter } from '../util/http';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export const BASE_URL = 'https://api.easee.com';

/** Timeout per request in ms */
export const HTTP_TIMEOUT_MS = 15_000;

/** Refresh the access token this long before it expires */
export const TOKEN_MARGIN_MS = 5 * 60_000;

/** Pause after a 429 without Retry-After */
export const DEFAULT_RATE_LIMIT_WAIT_MS = 5 * 60_000;

/** Easee serial numbers (e.g. 8 letters/digits); checking them keeps arbitrary text out of the URL */
export const SERIAL_PATTERN = /^[A-Z0-9]{6,16}$/;

/** Charging commands */
export type ChargeCommand = 'start_charging' | 'stop_charging' | 'pause_charging' | 'resume_charging';

/** Charger of the account */
export interface ChargerInfo {
    /** Serial number (= charger ID in the API) */
    serial: string;
    /** Name given in the Easee app */
    name: string;
}

/** Settings of the client */
export interface EaseeClientOptions {
    /** fetch implementation, defaults to the global fetch */
    fetch?: FetchFn;
    /** Base URL, defaults to the production API */
    baseUrl?: string;
    /** Timeout per request in ms */
    timeoutMs?: number;
    /** Clock (epoch ms) */
    now?: () => number;
}

interface Token {
    access: string;
    refresh: string;
    expiresAt: number;
}

/**
 * Client for one Easee account.
 */
export class EaseeClient {
    private readonly fetchFn: FetchFn;
    private readonly baseUrl: string;
    private readonly timeoutMs: number;
    private readonly now: () => number;
    private readonly shutdown = new AbortController();
    private token: Token | undefined;
    private pendingToken: Promise<Token> | undefined;

    /**
     * @param userName - E-mail or phone number of the Easee account
     * @param password - Password (kept in memory only)
     * @param options - Optional settings
     */
    public constructor(
        private readonly userName: string,
        private readonly password: string,
        options: EaseeClientOptions = {},
    ) {
        this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
        this.baseUrl = options.baseUrl ?? BASE_URL;
        this.timeoutMs = options.timeoutMs ?? HTTP_TIMEOUT_MS;
        this.now = options.now ?? Date.now;
    }

    /** Chargers of the account, sorted by serial (stable slot order) */
    public async getChargers(): Promise<ChargerInfo[]> {
        const body = await this.authorized('GET', '/api/chargers', 'chargers');
        if (!Array.isArray(body)) {
            throw new EaseeResponseError('chargers: unexpected answer (no list)');
        }
        const chargers: ChargerInfo[] = [];
        for (const entry of body) {
            const raw = (entry ?? {}) as Record<string, unknown>;
            const serial = typeof raw.id === 'string' ? raw.id.trim().toUpperCase() : '';
            if (!SERIAL_PATTERN.test(serial)) {
                continue;
            }
            const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 60) : '';
            chargers.push({ serial, name });
        }
        return chargers.sort((a, b) => a.serial.localeCompare(b.serial));
    }

    /**
     * Current observations of one charger.
     *
     * @param serial - Serial number
     * @param ids - Observation IDs, defaults to everything the adapter uses
     */
    public async getObservations(serial: string, ids: readonly number[] = OBSERVATION_IDS): Promise<RawObservation[]> {
        const query = new URLSearchParams({ ids: ids.join(',') });
        const body = await this.authorized(
            'GET',
            `/state/${checkSerial(serial)}/observations?${query.toString()}`,
            'observations',
        );
        const list = (body as { observations?: unknown } | null)?.observations;
        if (!Array.isArray(list)) {
            throw new EaseeResponseError('observations: unexpected answer (no observations list)');
        }
        const result: RawObservation[] = [];
        for (const entry of list) {
            const raw = (entry ?? {}) as Record<string, unknown>;
            if (typeof raw.id !== 'number' || !Number.isInteger(raw.id)) {
                continue;
            }
            result.push({
                id: raw.id,
                value: raw.value,
                timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : '',
            });
        }
        return result;
    }

    /**
     * Sends a charging command.
     *
     * @param serial - Serial number
     * @param command - Command
     */
    public async command(serial: string, command: ChargeCommand): Promise<void> {
        await this.authorized('POST', `/api/chargers/${checkSerial(serial)}/commands/${command}`, command);
    }

    /** Valid access token for the SignalR stream (shares login and refresh with REST) */
    public async accessToken(): Promise<string> {
        return (await this.validToken()).access;
    }

    /** Cancels running requests (adapter unload) */
    public abort(): void {
        this.shutdown.abort();
    }

    /**
     * Request with a valid access token; one retry with a new token after HTTP 401.
     *
     * @param method - GET / POST
     * @param path - Path incl. query
     * @param label - Short name for messages (never the path, it contains the serial)
     */
    private async authorized(method: string, path: string, label: string): Promise<unknown> {
        for (let attempt = 0; ; attempt++) {
            const token = await this.validToken();
            const response = await this.send(method, path, label, undefined, token.access);
            if (response.status === 401 && attempt === 0) {
                await response.body?.cancel().catch(() => undefined);
                if (this.token === token) {
                    this.token = { ...token, expiresAt: 0 }; // force refresh / login
                }
                continue;
            }
            return this.readJson(response, label);
        }
    }

    /** Access token that is valid for at least TOKEN_MARGIN_MS; parallel callers share one login */
    private async validToken(): Promise<Token> {
        if (this.token && this.token.expiresAt - TOKEN_MARGIN_MS > this.now()) {
            return this.token;
        }
        this.pendingToken ??= this.renewToken().finally(() => {
            this.pendingToken = undefined;
        });
        return this.pendingToken;
    }

    private async renewToken(): Promise<Token> {
        const old = this.token;
        if (old?.refresh) {
            try {
                const response = await this.send(
                    'POST',
                    '/api/accounts/refresh_token',
                    'token refresh',
                    { refreshToken: old.refresh },
                    old.access,
                );
                if (response.ok) {
                    this.token = this.parseToken(await this.readJson(response, 'token refresh'), old.refresh);
                    return this.token;
                }
                await response.body?.cancel().catch(() => undefined);
                if (response.status === 429) {
                    throw rateLimited(response, 'token refresh', this.now());
                }
                // refresh token invalid (Easee invalidates them now and then) -> fresh login below
            } catch (error) {
                if (!(error instanceof EaseeResponseError)) {
                    throw error;
                }
            }
        }
        this.token = undefined;
        const response = await this.send('POST', '/api/accounts/login', 'login', {
            userName: this.userName,
            password: this.password,
        });
        if (response.status === 400 || response.status === 401 || response.status === 403) {
            await response.body?.cancel().catch(() => undefined);
            throw new EaseeAuthError(`login rejected (HTTP ${response.status}) - check user name and password`);
        }
        this.token = this.parseToken(await this.readJson(response, 'login'), '');
        return this.token;
    }

    /**
     * @param body - Token answer
     * @param previousRefresh - Kept when the answer has no new refresh token
     */
    private parseToken(body: unknown, previousRefresh: string): Token {
        const raw = (body ?? {}) as Record<string, unknown>;
        if (typeof raw.accessToken !== 'string' || raw.accessToken === '') {
            throw new EaseeResponseError('token: unexpected answer (no access token)');
        }
        const expiresIn = typeof raw.expiresIn === 'number' && raw.expiresIn > 0 ? raw.expiresIn : 3600;
        return {
            access: raw.accessToken,
            refresh: typeof raw.refreshToken === 'string' && raw.refreshToken ? raw.refreshToken : previousRefresh,
            expiresAt: this.now() + expiresIn * 1000,
        };
    }

    /**
     * Raw request with timeout and shutdown handling.
     *
     * @param method - GET / POST
     * @param path - Path incl. query
     * @param label - Short name for messages
     * @param json - JSON body
     * @param bearer - Access token
     */
    private async send(
        method: string,
        path: string,
        label: string,
        json?: Record<string, string>,
        bearer?: string,
    ): Promise<Response> {
        if (!isAllowedRequest(method, path)) {
            // hard safety net: the account may be a site admin - never anything but the requests below
            throw new EaseeResponseError(`${label}: request blocked (not on the allow list)`);
        }
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (json) {
            headers['Content-Type'] = 'application/json';
        }
        if (bearer) {
            headers.Authorization = `Bearer ${bearer}`;
        }
        try {
            return await this.fetchFn(`${this.baseUrl}${path}`, {
                method,
                headers,
                body: json ? JSON.stringify(json) : method === 'POST' ? '' : undefined,
                signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(this.timeoutMs)]),
            });
        } catch (error) {
            if (this.shutdown.signal.aborted) {
                throw new EaseeAbortedError('Request aborted (shutdown)');
            }
            throw new EaseeNetworkError(`${label}: no answer (${networkReason(error)})`);
        }
    }

    /**
     * Maps status codes and parses JSON (empty body -> null).
     *
     * @param response - Answer
     * @param label - Short name for messages
     */
    private async readJson(response: Response, label: string): Promise<unknown> {
        if (response.status === 429) {
            await response.body?.cancel().catch(() => undefined);
            throw rateLimited(response, label, this.now());
        }
        const text = await response.text().catch(() => '');
        if (!response.ok) {
            throw new EaseeResponseError(`${label}: HTTP ${response.status}`, response.status);
        }
        if (text.trim() === '') {
            return null;
        }
        try {
            return JSON.parse(text);
        } catch {
            throw new EaseeResponseError(`${label}: HTTP ${response.status}, answer is not JSON`, response.status);
        }
    }
}

/**
 * @param response - 429 answer
 * @param label - Short name for messages
 * @param now - Current time
 */
function rateLimited(response: Response, label: string, now: number): EaseeRateLimitedError {
    const waitMs = parseRetryAfter(response.headers.get('retry-after'), now) ?? DEFAULT_RATE_LIMIT_WAIT_MS;
    return new EaseeRateLimitedError(`${label}: too many requests (HTTP 429)`, waitMs);
}

/**
 * The only requests this client may ever send. The account can be the admin of a whole site,
 * so nothing that deletes or changes settings, sites, users or chargers is allowed - no DELETE,
 * no PUT/PATCH, no settings endpoints. Only reading, login and the four charging commands.
 */
const ALLOWED_REQUESTS: readonly { method: 'GET' | 'POST'; path: RegExp }[] = [
    { method: 'POST', path: /^\/api\/accounts\/login$/ },
    { method: 'POST', path: /^\/api\/accounts\/refresh_token$/ },
    { method: 'GET', path: /^\/api\/chargers$/ },
    { method: 'GET', path: /^\/state\/[A-Z0-9]{6,16}\/observations\?ids=[0-9%C,]+$/ },
    {
        method: 'POST',
        path: /^\/api\/chargers\/[A-Z0-9]{6,16}\/commands\/(start_charging|stop_charging|pause_charging|resume_charging)$/,
    },
];

/**
 * @param method - HTTP method
 * @param path - Path incl. query
 */
export function isAllowedRequest(method: string, path: string): boolean {
    return ALLOWED_REQUESTS.some(rule => rule.method === method && rule.path.test(path));
}

/**
 * @param serial - Serial from the charger list
 */
function checkSerial(serial: string): string {
    if (!SERIAL_PATTERN.test(serial)) {
        throw new EaseeResponseError('Invalid charger serial format');
    }
    return serial;
}
