/*
 * Client for the official FordConnect Query API (read-only), checked 2026-11-05 against the
 * reference marq24/ha-fordconnect-query 2026.10.7 (Apache-2.0, used as reading material only):
 *  - authorize: https://api.vehicle.ford.com/fcon-public/v1/auth/init
 *      ?response_type=code&client_id=..&redirect_uri=..&state=.. (state: at most 16 characters)
 *    On the Ford page the user logs in and picks ONE vehicle -> one token set per vehicle.
 *  - token:     https://api.vehicle.ford.com/dah2vb2cprod.onmicrosoft.com/oauth2/v2.0/token?p=B2C_1A_FCON_AUTHORIZE
 *      form: grant_type=authorization_code|refresh_token, client_id, client_secret, code/refresh_token, redirect_uri
 *    Access token about 20 min. A refresh answer may come without a new refresh_token (keep the old).
 *    The login itself expires about one year after auth_time (id_token) -> new browser login.
 *  - data:      GET https://api.vehicle.ford.com/fcon-query/v1/garage | /telemetry | /vehicle-health/alerts
 *    429 with Retry-After (reference falls back to 62 s).
 *
 * Secrets (client secret, tokens, code) are never part of a message; the VIN is never logged.
 */

import {
    FordAbortedError,
    FordClientRejectedError,
    FordLoginRequiredError,
    FordNetworkError,
    FordRateLimitedError,
    FordResponseError,
} from './errors';
import { networkReason, parseRetryAfter } from '../util/http';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export const BASE_URL = 'https://api.vehicle.ford.com';
export const AUTHORIZE_PATH = '/fcon-public/v1/auth/init';
export const TOKEN_PATH = '/dah2vb2cprod.onmicrosoft.com/oauth2/v2.0/token?p=B2C_1A_FCON_AUTHORIZE';
export const QUERY_PATH = '/fcon-query/v1';

export const HTTP_TIMEOUT_MS = 45_000;
/** Refresh the access token this long before it expires */
export const TOKEN_MARGIN_MS = 2 * 60_000;
/** Pause after a 429 without Retry-After (reference: 62 s) */
export const DEFAULT_RATE_LIMIT_WAIT_MS = 62_000;
/** Refreshes answered with AADB2C90085 that are retried before a new login is needed */
export const INTERNAL_ERROR_RETRIES = 3;
/** The login expires this long after auth_time */
export const LOGIN_LIFETIME_MS = 365 * 24 * 3_600_000;

/** Token set of one vehicle (stored encrypted by the adapter) */
export interface FordToken {
    /** Access token */
    access: string;
    /** Refresh token */
    refresh: string;
    /** Access token expiry (epoch ms) */
    expiresAt: number;
    /** Time of the browser login (epoch ms), from the id_token if available */
    authTime: number | null;
}

/** Vehicle info from /garage (VIN deliberately left out) */
export interface GarageInfo {
    /** e.g. "2024 Kuga" */
    vehicleType: string;
    /** e.g. BEV, ICE, HEV, PHEV */
    engineType: string;
    /** Colour text */
    color: string;
}

/** Settings of the client */
export interface FordClientOptions {
    /** fetch implementation */
    fetch?: FetchFn;
    /** Base URL */
    baseUrl?: string;
    /** Timeout per request */
    timeoutMs?: number;
    /** Clock */
    now?: () => number;
}

/** Where the token of one vehicle lives */
export interface TokenStore {
    /** Last saved token, undefined if there is none */
    load(): Promise<FordToken | undefined>;
    /** Saves the token (encrypted) */
    save(token: FordToken | undefined): Promise<void>;
}

/**
 * Builds the URL the user opens in the browser.
 *
 * @param clientId - App client ID
 * @param redirectUri - Redirect URI registered in the portal
 * @param state - Random state, at most 16 characters
 * @param baseUrl - Base URL (tests)
 */
export function buildAuthorizeUrl(clientId: string, redirectUri: string, state: string, baseUrl = BASE_URL): string {
    const query = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        state: state.slice(0, 16),
    });
    return `${baseUrl}${AUTHORIZE_PATH}?${query.toString()}`;
}

/**
 * Reads code and state from what the user pastes: the whole address of the (error) page after the
 * login, only the query part, or only the code.
 *
 * @param text - Pasted text
 */
export function parseRedirect(text: string): { code: string; state: string | null; error: string | null } {
    const trimmed = text.trim();
    const query = trimmed.includes('?') ? trimmed.slice(trimmed.indexOf('?') + 1) : trimmed;
    if (query.includes('=')) {
        const params = new URLSearchParams(query.split('#')[0]);
        return {
            code: params.get('code') ?? '',
            state: params.get('state'),
            error: params.get('error_description') ?? params.get('error'),
        };
    }
    return { code: trimmed, state: null, error: null };
}

/** Ford login error seen with accounts that only have shared vehicle access (cause unclear). */
export const B2C_SHARED_ACCESS_ERROR = 'AADB2C90085';

/**
 * Azure AD B2C error code (e.g. AADB2C90085) from an error text, without the rest of the text.
 *
 * @param text - Error text or description
 */
export function b2cErrorCode(text: string | null | undefined): string | null {
    const match = /AADB2C\d{5}/.exec(text ?? '');
    return match ? match[0] : null;
}

/**
 * auth_time from the payload of an id_token (no signature check needed, only for the reminder).
 *
 * @param idToken - JWT
 */
export function authTimeFromIdToken(idToken: unknown): number | null {
    if (typeof idToken !== 'string') {
        return null;
    }
    const part = idToken.split('.')[1];
    if (!part) {
        return null;
    }
    try {
        const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { auth_time?: unknown };
        return typeof payload.auth_time === 'number' ? payload.auth_time * 1000 : null;
    } catch {
        return null;
    }
}

/**
 * Client for one vehicle (one token set).
 */
export class FordClient {
    private readonly fetchFn: FetchFn;
    private readonly baseUrl: string;
    private readonly timeoutMs: number;
    private readonly now: () => number;
    private readonly shutdown = new AbortController();
    private token: FordToken | undefined;
    private loaded = false;
    private pending: Promise<FordToken> | undefined;
    /** Refreshes in a row that Ford answered with its internal error AADB2C90085 */
    private internalErrors = 0;

    /**
     * @param clientId - App client ID
     * @param clientSecret - App client secret
     * @param redirectUri - Redirect URI registered in the portal
     * @param store - Token storage of this vehicle
     * @param options - Optional settings
     */
    public constructor(
        private readonly clientId: string,
        private readonly clientSecret: string,
        private readonly redirectUri: string,
        private readonly store: TokenStore,
        options: FordClientOptions = {},
    ) {
        this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
        this.baseUrl = options.baseUrl ?? BASE_URL;
        this.timeoutMs = options.timeoutMs ?? HTTP_TIMEOUT_MS;
        this.now = options.now ?? Date.now;
    }

    /** A token is stored (the user has logged in at least once) */
    public async hasLogin(): Promise<boolean> {
        await this.loadToken();
        return this.token !== undefined;
    }

    /** Time of the browser login, null if unknown */
    public authTime(): number | null {
        return this.token?.authTime ?? null;
    }

    /**
     * Exchanges the code from the browser login for tokens.
     *
     * @param code - Authorization code
     */
    public async login(code: string): Promise<void> {
        const body = await this.tokenRequest({
            grant_type: 'authorization_code',
            code,
            redirect_uri: this.redirectUri,
        });
        this.token = this.parseToken(body, '', null);
        await this.store.save(this.token);
    }

    /** Forgets the stored login (after a rejected refresh token) */
    public async forgetLogin(): Promise<void> {
        this.token = undefined;
        await this.store.save(undefined);
    }

    /** Vehicle of this login */
    public async getGarage(): Promise<GarageInfo> {
        const body = (await this.get('/garage', 'garage')) as Record<string, unknown> | null;
        const raw = body ?? {};
        const text = (value: unknown): string => (typeof value === 'string' ? value.trim().slice(0, 60) : '');
        return {
            vehicleType: text(raw.vehicleType) || text(raw.modelName),
            engineType: text(raw.engineType),
            color: text(raw.color),
        };
    }

    /** Telemetry (metrics) of the vehicle */
    public async getTelemetry(): Promise<Record<string, unknown>> {
        const body = await this.get('/telemetry', 'telemetry');
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            throw new FordResponseError('telemetry: unexpected answer');
        }
        return body as Record<string, unknown>;
    }

    /** Cancels running requests */
    public abort(): void {
        this.shutdown.abort();
    }

    private async loadToken(): Promise<void> {
        if (!this.loaded) {
            this.loaded = true;
            this.token = await this.store.load();
        }
    }

    /**
     * GET on the query API with a valid token; one retry with a fresh token after 401.
     *
     * @param path - Path below /fcon-query/v1
     * @param label - Name for messages
     */
    private async get(path: string, label: string): Promise<unknown> {
        for (let attempt = 0; ; attempt++) {
            const token = await this.validToken();
            const response = await this.send(`${QUERY_PATH}${path}`, label, {
                method: 'GET',
                headers: { Accept: 'application/json', Authorization: `Bearer ${token.access}` },
            });
            if (response.status === 401 && attempt === 0) {
                await response.body?.cancel().catch(() => undefined);
                if (this.token === token) {
                    this.token = { ...token, expiresAt: 0 };
                }
                continue;
            }
            return this.readJson(response, label);
        }
    }

    private async validToken(): Promise<FordToken> {
        await this.loadToken();
        if (!this.token) {
            throw new FordLoginRequiredError('no login yet');
        }
        if (this.token.expiresAt - TOKEN_MARGIN_MS > this.now()) {
            return this.token;
        }
        this.pending ??= this.refresh().finally(() => {
            this.pending = undefined;
        });
        return this.pending;
    }

    private async refresh(): Promise<FordToken> {
        const old = this.token;
        if (!old?.refresh) {
            throw new FordLoginRequiredError('no refresh token');
        }
        const body = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: old.refresh });
        this.internalErrors = 0;
        this.token = this.parseToken(body, old.refresh, old.authTime);
        await this.store.save(this.token);
        return this.token;
    }

    /**
     * POST to the token endpoint (form encoded, client credentials in the body).
     *
     * @param params - Grant parameters
     */
    private async tokenRequest(params: Record<string, string>): Promise<unknown> {
        const form = new URLSearchParams({ ...params, client_id: this.clientId, client_secret: this.clientSecret });
        const label = params.grant_type === 'refresh_token' ? 'token refresh' : 'login';
        const response = await this.send(TOKEN_PATH, label, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form.toString(),
        });
        if (response.status === 429) {
            await response.body?.cancel().catch(() => undefined);
            throw this.rateLimited(response, label);
        }
        const text = await response.text().catch(() => '');
        if (response.ok) {
            try {
                return JSON.parse(text);
            } catch {
                throw new FordResponseError(`${label}: answer is not JSON`, response.status);
            }
        }
        const error = oauthError(text);
        const b2c = b2cErrorCode(text);
        if (error === 'invalid_client' || error === 'unauthorized_client') {
            throw new FordClientRejectedError(`${label}: client ID/secret rejected (${error})`, response.status);
        }
        if (
            params.grant_type === 'refresh_token' &&
            b2c === B2C_SHARED_ACCESS_ERROR &&
            this.internalErrors < INTERNAL_ERROR_RETRIES
        ) {
            // AADB2C90085 = "internal error" at Ford (18.11.2026: the stored login was dropped because of it).
            // Keep the refresh token and try again later; only after several in a row a new login is needed.
            this.internalErrors++;
            throw new FordResponseError(`${label}: Ford reported ${b2c}, keeping the login and trying again`);
        }
        if (response.status === 400 || response.status === 401) {
            // invalid_grant: code used/expired or refresh token expired -> new browser login
            const reason = [error || `HTTP ${response.status}`, b2c].filter(Boolean).join(', ');
            throw new FordLoginRequiredError(`${label}: rejected (${reason})`);
        }
        throw new FordResponseError(`${label}: HTTP ${response.status}`, response.status);
    }

    /**
     * @param body - Token answer
     * @param previousRefresh - Kept when the answer has no refresh token
     * @param previousAuthTime - Kept when the answer has no id_token
     */
    private parseToken(body: unknown, previousRefresh: string, previousAuthTime: number | null): FordToken {
        const raw = (body ?? {}) as Record<string, unknown>;
        if (typeof raw.access_token !== 'string' || raw.access_token === '') {
            throw new FordResponseError('token: unexpected answer (no access token)');
        }
        const expiresIn = Number(raw.expires_in);
        return {
            access: raw.access_token,
            refresh: typeof raw.refresh_token === 'string' && raw.refresh_token ? raw.refresh_token : previousRefresh,
            expiresAt: this.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 1200) * 1000,
            authTime: authTimeFromIdToken(raw.id_token) ?? previousAuthTime ?? (previousRefresh ? null : this.now()),
        };
    }

    /**
     * @param path - Path incl. query
     * @param label - Name for messages
     * @param init - Request
     */
    private async send(path: string, label: string, init: RequestInit): Promise<Response> {
        try {
            return await this.fetchFn(`${this.baseUrl}${path}`, {
                ...init,
                signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(this.timeoutMs)]),
            });
        } catch (error) {
            if (this.shutdown.signal.aborted) {
                throw new FordAbortedError('Request aborted (shutdown)');
            }
            throw new FordNetworkError(`${label}: no answer (${networkReason(error)})`);
        }
    }

    /**
     * @param response - Answer
     * @param label - Name for messages
     */
    private async readJson(response: Response, label: string): Promise<unknown> {
        if (response.status === 429) {
            await response.body?.cancel().catch(() => undefined);
            throw this.rateLimited(response, label);
        }
        const text = await response.text().catch(() => '');
        if (response.status === 401 || response.status === 403) {
            throw new FordLoginRequiredError(`${label}: access denied (HTTP ${response.status})`);
        }
        if (!response.ok) {
            // a 400 usually says which parameter is wrong; short, single line, no vehicle number
            const hint =
                response.status === 400
                    ? text
                          .replace(/\s+/g, ' ')
                          .replace(/\b[A-HJ-NPR-Z0-9]{17}\b/g, '…')
                          .trim()
                          .slice(0, 160)
                    : '';
            throw new FordResponseError(
                `${label}: HTTP ${response.status}${hint ? ` (${hint})` : ''}`,
                response.status,
            );
        }
        if (text.trim() === '') {
            return null;
        }
        try {
            return JSON.parse(text);
        } catch {
            throw new FordResponseError(`${label}: answer is not JSON`, response.status);
        }
    }

    /**
     * @param response - 429 answer
     * @param label - Name for messages
     */
    private rateLimited(response: Response, label: string): FordRateLimitedError {
        const waitMs = parseRetryAfter(response.headers.get('retry-after'), this.now()) ?? DEFAULT_RATE_LIMIT_WAIT_MS;
        return new FordRateLimitedError(`${label}: too many requests (HTTP 429)`, waitMs);
    }
}

/**
 * OAuth error code of an error answer (short, no description - it may echo input).
 *
 * @param text - Body
 */
function oauthError(text: string): string {
    try {
        const error = (JSON.parse(text) as { error?: unknown }).error;
        return typeof error === 'string' ? error.replace(/[^a-z_]/gi, '').slice(0, 40) : '';
    } catch {
        return '';
    }
}
