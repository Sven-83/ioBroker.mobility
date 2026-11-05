/*
 * Client for the free Tankerkoenig API (data of the German Markttransparenzstelle, CC BY 4.0).
 * Rules from https://creativecommons.tankerkoenig.de (checked 2026-11-05):
 *  - technically at most one request per minute; home automation at most every 5 minutes,
 *    not at round times (random offset) -> enforced by the fuel service, not here
 *  - prices.php: up to 10 known stations per request
 *  - master data (detail.php) rarely, at most daily
 *  - the API key must never be published (it is a query parameter, so URLs are never logged)
 */

import {
    FuelAbortedError,
    FuelKeyRejectedError,
    FuelNetworkError,
    FuelRateLimitedError,
    FuelRefusedError,
    FuelResponseError,
} from './errors';
import { networkReason, parseRetryAfter } from '../util/http';

export { MAX_RETRY_AFTER_MS, parseRetryAfter } from '../util/http';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export const BASE_URL = 'https://creativecommons.tankerkoenig.de/json';

/** Timeout per request in ms */
export const HTTP_TIMEOUT_MS = 10_000;

/** prices.php accepts at most this many station IDs */
export const MAX_STATIONS_PER_REQUEST = 10;

/** Pause after a 429 without Retry-After */
export const DEFAULT_RATE_LIMIT_WAIT_MS = 15 * 60_000;

/** Station IDs are UUIDs; checking them keeps arbitrary strings out of the URL */
export const STATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** API keys are UUIDs as well */
export const API_KEY_PATTERN = STATION_ID_PATTERN;

/** Price state of one station from prices.php */
export interface StationPrices {
    /** "open", "closed", "no prices", "not found" or what the API sends */
    status: string;
    /** Super E10 in EUR per litre, null if the station has no E10 price (the only fuel we need) */
    e10: number | null;
}

/** Master data of one station from detail.php (only what we show) */
export interface StationDetail {
    /** Station name */
    name: string;
    /** Brand */
    brand: string;
    /** Street */
    street: string;
    /** House number */
    houseNumber: string;
    /** Post code */
    postCode: string;
    /** Town */
    place: string;
    /** Open right now, null if unknown */
    isOpen: boolean | null;
    /** Open 24 h, null if unknown */
    wholeDay: boolean | null;
}

/** Settings of the client */
export interface TankerkoenigClientOptions {
    /** fetch implementation, defaults to the global fetch */
    fetch?: FetchFn;
    /** Base URL, defaults to the production API */
    baseUrl?: string;
    /** Timeout per request in ms */
    timeoutMs?: number;
    /** Clock for Retry-After dates */
    now?: () => number;
}

/**
 * Removes whitespace and control characters that sneak in when the key is pasted.
 *
 * @param key - Key from the instance config
 */
export function normalizeApiKey(key: unknown): string {
    // eslint-disable-next-line no-control-regex -- removing control chars is the point here
    return typeof key === 'string' ? key.replace(/[\u0000-\u001f\u007f\s]/g, '').toLowerCase() : '';
}

/**
 * Client for one API key.
 */
export class TankerkoenigClient {
    private readonly fetchFn: FetchFn;
    private readonly baseUrl: string;
    private readonly timeoutMs: number;
    private readonly now: () => number;
    private readonly shutdown = new AbortController();

    /**
     * @param apiKey - Normalised API key
     * @param options - Optional settings
     */
    public constructor(
        private readonly apiKey: string,
        options: TankerkoenigClientOptions = {},
    ) {
        this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
        this.baseUrl = options.baseUrl ?? BASE_URL;
        this.timeoutMs = options.timeoutMs ?? HTTP_TIMEOUT_MS;
        this.now = options.now ?? Date.now;
    }

    /**
     * Current prices of up to 10 stations (prices.php).
     *
     * @param stationIds - Station IDs (UUIDs)
     * @returns Map station ID (lower case) -> prices; stations the API does not mention are missing
     */
    public async getPrices(stationIds: string[]): Promise<Map<string, StationPrices>> {
        const ids = stationIds.map(checkStationId);
        if (ids.length === 0 || ids.length > MAX_STATIONS_PER_REQUEST) {
            throw new FuelResponseError(`prices.php needs 1-${MAX_STATIONS_PER_REQUEST} stations, got ${ids.length}`);
        }
        const body = await this.getJson('prices.php', { ids: ids.join(',') });
        const prices = (body as { prices?: unknown }).prices;
        if (typeof prices !== 'object' || prices === null || Array.isArray(prices)) {
            throw new FuelResponseError('Unexpected answer of prices.php (no prices object)');
        }
        const result = new Map<string, StationPrices>();
        for (const [id, entry] of Object.entries(prices as Record<string, unknown>)) {
            if (!STATION_ID_PATTERN.test(id) || typeof entry !== 'object' || entry === null) {
                continue;
            }
            const raw = entry as Record<string, unknown>;
            result.set(id.toLowerCase(), {
                status: typeof raw.status === 'string' ? raw.status.slice(0, 40) : 'unknown',
                e10: parsePrice(raw.e10),
            });
        }
        return result;
    }

    /**
     * Master data of one station (detail.php). Use rarely (at most daily).
     *
     * @param stationId - Station ID (UUID)
     */
    public async getDetail(stationId: string): Promise<StationDetail> {
        const body = await this.getJson('detail.php', { id: checkStationId(stationId) });
        const station = (body as { station?: unknown }).station;
        if (typeof station !== 'object' || station === null) {
            throw new FuelResponseError('Unexpected answer of detail.php (no station object)');
        }
        const raw = station as Record<string, unknown>;
        return {
            name: text(raw.name),
            brand: text(raw.brand),
            street: text(raw.street),
            houseNumber: text(raw.houseNumber),
            postCode: text(raw.postCode),
            place: text(raw.place),
            isOpen: typeof raw.isOpen === 'boolean' ? raw.isOpen : null,
            wholeDay: typeof raw.wholeDay === 'boolean' ? raw.wholeDay : null,
        };
    }

    /** Cancels running requests (adapter unload) */
    public abort(): void {
        this.shutdown.abort();
    }

    /**
     * GET with key, timeout and error mapping. The URL contains the key and is never logged.
     *
     * @param file - prices.php / detail.php
     * @param params - Query parameters without the key
     */
    private async getJson(file: string, params: Record<string, string>): Promise<unknown> {
        const query = new URLSearchParams({ ...params, apikey: this.apiKey });
        let response: Response;
        try {
            response = await this.fetchFn(`${this.baseUrl}/${file}?${query.toString()}`, {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(this.timeoutMs)]),
            });
        } catch (error) {
            if (this.shutdown.signal.aborted) {
                throw new FuelAbortedError('Request aborted (shutdown)');
            }
            throw new FuelNetworkError(`${file}: no answer (${networkReason(error)})`);
        }

        if (response.status === 429) {
            await response.body?.cancel().catch(() => undefined);
            const waitMs =
                parseRetryAfter(response.headers.get('retry-after'), this.now()) ?? DEFAULT_RATE_LIMIT_WAIT_MS;
            throw new FuelRateLimitedError(`${file}: too many requests (HTTP 429)`, waitMs);
        }

        const textBody = await response.text().catch(() => '');
        let body: unknown;
        try {
            body = JSON.parse(textBody);
        } catch {
            throw new FuelResponseError(`${file}: HTTP ${response.status}, answer is not JSON`, response.status);
        }
        const ok = (body as { ok?: unknown } | null)?.ok;
        const message = shortMessage((body as { message?: unknown } | null)?.message);
        // real answer for an unknown key (2026-11-05): HTTP 200, {"status":"error","ok":false,
        // "message":"Key existiert nicht oder ist deaktiviert"}
        if (
            response.status === 401 ||
            response.status === 403 ||
            (ok === false && /(api-?key|\bkey\b)/i.test(message))
        ) {
            throw new FuelKeyRejectedError(`${file}: API key rejected (${message || `HTTP ${response.status}`})`);
        }
        if (ok === false && /(too many|zu viele|rate)/i.test(message)) {
            throw new FuelRateLimitedError(`${file}: too many requests (${message})`, DEFAULT_RATE_LIMIT_WAIT_MS);
        }
        if (ok === false) {
            throw new FuelRefusedError(
                `${file}: request refused (${message || `HTTP ${response.status}`})`,
                response.status,
            );
        }
        if (!response.ok || ok !== true) {
            throw new FuelResponseError(
                `${file}: HTTP ${response.status}${message ? ` (${message})` : ''}`,
                response.status,
            );
        }
        return body;
    }
}

/**
 * @param id - Station ID from the config
 * @returns The ID in lower case
 */
function checkStationId(id: string): string {
    if (!STATION_ID_PATTERN.test(id)) {
        throw new FuelResponseError('Invalid station ID format (expected UUID)');
    }
    return id.toLowerCase();
}

/**
 * Prices are numbers; the API sends false when a station has no price for a fuel.
 * Plausibility range protects the history from garbage.
 *
 * @param value - Raw value
 */
export function parsePrice(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.3 || value > 5) {
        return null;
    }
    return Math.round(value * 1000) / 1000;
}

/**
 * @param value - Raw value
 */
function text(value: unknown): string {
    return typeof value === 'string' ? value.trim().slice(0, 100) : '';
}

/**
 * @param value - message field of an answer
 */
function shortMessage(value: unknown): string {
    return typeof value === 'string' ? value.slice(0, 200) : '';
}
