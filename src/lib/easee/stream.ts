/*
 * Easee real-time stream (SignalR, JSON protocol over WebSocket), developer.easee.com
 * "SignalR Streaming API" checked 2026-11-05:
 *  - hub https://streams.easee.com/hubs/products (moved from api.easee.cloud/hubs)
 *  - access token from the normal login; after connecting call SubscribeWithCurrentState(serial, true)
 *    once per charger -> the current state is replayed, then "ProductUpdate" messages
 *    {mid, dataType, id, timestamp, value} follow ("the value is always transmitted as a string")
 *  - commands stay on REST
 * Probe 2026-11-05 without a token: negotiate answers 401, the WebSocket is refused -> auth needed.
 *
 * No SignalR library: the protocol part we need is small, and Node >= 22 has a global WebSocket.
 * Flow: POST {hub}/negotiate?negotiateVersion=1 (Bearer) -> connectionToken; the load balancer
 * cookie (AWSALB) is passed on, so the WebSocket reaches the same server. If negotiate is not
 * available (404/405), the WebSocket is opened directly (SignalR "skip negotiation").
 *
 * Reliability (experience of other integrations):
 *  - client ping every 15 s, server pings every 15 s; 60 s without any message = dead -> reconnect
 *  - reconnect with backoff 5 s .. 5 min, reset after 2 min stable connection
 *  - the stream can go silent for one charger after start/stop -> resubscribe() 15 s after commands
 *
 * Token and URL are never logged (the token is part of the WebSocket URL).
 */

import type { Logger, TimerHandle } from '../fuel/fuel-service';
import { describeError } from '../fuel/errors';
import { networkReason } from '../util/http';
import { EaseeAuthError } from './errors';
import type { RawObservation } from './observations';

export const HUB_URL = 'https://streams.easee.com/hubs/products';

/** SignalR record separator */
const RS = '\u001e';

export const PING_INTERVAL_MS = 15_000;
export const SILENCE_TIMEOUT_MS = 60_000;
export const HANDSHAKE_TIMEOUT_MS = 15_000;
export const MIN_RECONNECT_MS = 5_000;
export const MAX_RECONNECT_MS = 5 * 60_000;
export const STABLE_AFTER_MS = 2 * 60_000;

/** The subset of the WHATWG WebSocket the stream uses */
export interface SocketLike {
    /** Sends a text frame */
    send(data: string): void;
    /** Closes the socket */
    close(code?: number, reason?: string): void;
    /** Open handler */
    onopen: ((event: unknown) => void) | null;
    /** Message handler */
    onmessage: ((event: { data: unknown }) => void) | null;
    /** Close handler */
    onclose: ((event: { code: number; reason: string }) => void) | null;
    /** Error handler */
    onerror: ((event: unknown) => void) | null;
}

/** Everything the stream needs from the outside */
export interface StreamDeps {
    /** Valid access token (shares login/refresh with the REST client) */
    getToken(): Promise<string>;
    /** Opens a WebSocket */
    createSocket(url: string, headers: Record<string, string>): SocketLike;
    /** HTTP for negotiate */
    fetch(input: string, init?: RequestInit): Promise<Response>;
    /** Adapter log */
    log: Logger;
    /** Current time */
    now(): number;
    /** adapter.setTimeout */
    setTimeout(callback: () => void, ms: number): TimerHandle;
    /** adapter.clearTimeout */
    clearTimeout(handle: TimerHandle): void;
    /** One pushed observation */
    onObservation(serial: string, observation: RawObservation): void;
    /** Stream up (handshake done, subscriptions sent) or down */
    onConnection(connected: boolean): void;
}

/**
 * One SignalR connection for all chargers of the account.
 */
export class EaseeStream {
    private socket: SocketLike | undefined;
    private serials: string[] = [];
    private readonly timers = new Map<string, TimerHandle>();
    private stopped = true;
    private connected = false;
    private handshakeDone = false;
    private buffer = '';
    private lastMessageAt = 0;
    private connectedAt = 0;
    private attempts = 0;
    private invocationId = 0;
    private failureLogged = false;

    /**
     * @param deps - Dependencies
     * @param hubUrl - Hub URL (tests)
     */
    public constructor(
        private readonly deps: StreamDeps,
        private readonly hubUrl = HUB_URL,
    ) {}

    /** Stream is up */
    public isConnected(): boolean {
        return this.connected;
    }

    /**
     * Connects and subscribes the given chargers.
     *
     * @param serials - Serial numbers
     */
    public start(serials: string[]): void {
        this.serials = [...serials];
        this.stopped = false;
        void this.connect();
    }

    /** Closes the connection for good */
    public stop(): void {
        this.stopped = true;
        for (const handle of this.timers.values()) {
            this.deps.clearTimeout(handle);
        }
        this.timers.clear();
        this.closeSocket();
        this.setConnected(false);
    }

    /**
     * Subscribes one charger again (stream may go silent after start/stop).
     *
     * @param serial - Serial number
     */
    public resubscribe(serial: string): void {
        if (this.connected && this.serials.includes(serial)) {
            this.subscribe(serial);
        }
    }

    private async connect(): Promise<void> {
        if (this.stopped) {
            return;
        }
        this.closeSocket();
        try {
            const token = await this.deps.getToken();
            const { url, headers } = await this.negotiate(token);
            if (this.stopped) {
                return;
            }
            this.open(url, headers);
        } catch (error) {
            if (error instanceof EaseeAuthError) {
                // the REST part reports the rejected login and stops; never retry a rejected login
                this.stop();
                return;
            }
            this.failed(`connect failed: ${describeError(error)}`);
        }
    }

    /**
     * @param token - Access token
     * @returns WebSocket URL (wss, with connection token and access token) and headers
     */
    private async negotiate(token: string): Promise<{ url: string; headers: Record<string, string> }> {
        let response: Response;
        try {
            response = await this.deps.fetch(`${this.hubUrl}/negotiate?negotiateVersion=1`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Length': '0' },
                signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
            });
        } catch (error) {
            throw new Error(`negotiate: no answer (${networkReason(error)})`);
        }
        const wsBase = this.hubUrl.replace(/^http/, 'ws');
        const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
        if (response.status === 404 || response.status === 405) {
            await response.body?.cancel().catch(() => undefined);
            return { url: `${wsBase}?access_token=${encodeURIComponent(token)}`, headers };
        }
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error(`negotiate: HTTP ${response.status}`);
        }
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        // Azure SignalR style redirect
        if (typeof body.url === 'string' && typeof body.accessToken === 'string') {
            const redirect = body.url.replace(/^http/, 'ws');
            const sep = redirect.includes('?') ? '&' : '?';
            return {
                url: `${redirect}${sep}access_token=${encodeURIComponent(body.accessToken)}`,
                headers: { Authorization: `Bearer ${body.accessToken}` },
            };
        }
        const id =
            typeof body.connectionToken === 'string'
                ? body.connectionToken
                : typeof body.connectionId === 'string'
                  ? body.connectionId
                  : '';
        if (!id) {
            throw new Error('negotiate: no connection token');
        }
        const cookies = cookieHeader(response.headers);
        if (cookies) {
            headers.Cookie = cookies;
        }
        return {
            url: `${wsBase}?id=${encodeURIComponent(id)}&access_token=${encodeURIComponent(token)}`,
            headers,
        };
    }

    /**
     * @param url - WebSocket URL
     * @param headers - Headers
     */
    private open(url: string, headers: Record<string, string>): void {
        let socket: SocketLike;
        try {
            socket = this.deps.createSocket(url, headers);
        } catch (error) {
            this.failed(`WebSocket could not be created: ${networkReason(error)}`);
            return;
        }
        this.socket = socket;
        this.handshakeDone = false;
        this.buffer = '';
        this.lastMessageAt = this.deps.now();
        socket.onopen = () => {
            socket.send(`${JSON.stringify({ protocol: 'json', version: 1 })}${RS}`);
            this.timer('handshake', HANDSHAKE_TIMEOUT_MS, () => this.drop('no handshake answer'));
        };
        socket.onmessage = event => {
            if (socket === this.socket) {
                this.receive(typeof event.data === 'string' ? event.data : String(event.data));
            }
        };
        socket.onerror = () => {
            // details follow in onclose; undici puts no useful text here
        };
        socket.onclose = event => {
            if (socket === this.socket) {
                this.socket = undefined;
                this.drop(`closed (code ${event.code})`);
            }
        };
    }

    /**
     * @param data - Text frame (one or more records)
     */
    private receive(data: string): void {
        this.lastMessageAt = this.deps.now();
        this.buffer += data;
        let index: number;
        while ((index = this.buffer.indexOf(RS)) >= 0) {
            const record = this.buffer.slice(0, index);
            this.buffer = this.buffer.slice(index + 1);
            if (record.trim() !== '') {
                this.handleRecord(record);
            }
        }
        if (this.buffer.length > 1_000_000) {
            this.drop('oversized message');
        }
    }

    /**
     * @param record - One JSON record
     */
    private handleRecord(record: string): void {
        let message: Record<string, unknown>;
        try {
            message = JSON.parse(record) as Record<string, unknown>;
        } catch {
            this.deps.log.debug('Easee stream: ignored a record that is not JSON');
            return;
        }
        if (!this.handshakeDone) {
            this.clearTimer('handshake');
            if (typeof message.error === 'string') {
                this.drop(`handshake refused (${message.error.slice(0, 100)})`);
                return;
            }
            this.handshakeDone = true;
            this.onHandshake();
            return;
        }
        switch (message.type) {
            case 1:
                this.handleInvocation(message);
                break;
            case 3:
                if (typeof message.error === 'string') {
                    this.deps.log.warn(`Easee stream: subscription failed (${message.error.slice(0, 100)})`);
                }
                break;
            case 7:
                this.drop(
                    `server closed the stream${typeof message.error === 'string' ? ` (${message.error.slice(0, 100)})` : ''}`,
                );
                break;
            default:
                break; // 6 = ping, others are not used
        }
    }

    private onHandshake(): void {
        this.connectedAt = this.deps.now();
        for (const serial of this.serials) {
            this.subscribe(serial);
        }
        this.setConnected(true);
        if (this.failureLogged) {
            this.deps.log.info('Easee stream connected again');
            this.failureLogged = false;
        } else {
            this.deps.log.info('Easee stream connected (real-time values)');
        }
        this.schedulePing();
    }

    /**
     * @param message - Invocation
     */
    private handleInvocation(message: Record<string, unknown>): void {
        const args = Array.isArray(message.arguments) ? message.arguments : [];
        if (message.target !== 'ProductUpdate') {
            return; // ChargerUpdate / CommandResponse are not needed
        }
        for (const arg of args) {
            const raw = (arg ?? {}) as Record<string, unknown>;
            const serial = typeof raw.mid === 'string' ? raw.mid.toUpperCase() : '';
            if (!this.serials.includes(serial) || typeof raw.id !== 'number') {
                continue;
            }
            this.deps.onObservation(serial, {
                id: raw.id,
                value: raw.value,
                timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : '',
            });
        }
    }

    /**
     * @param serial - Serial number
     */
    private subscribe(serial: string): void {
        this.invocationId++;
        this.sendRecord({
            type: 1,
            invocationId: String(this.invocationId),
            target: 'SubscribeWithCurrentState',
            arguments: [serial, true],
        });
    }

    private schedulePing(): void {
        this.timer('ping', PING_INTERVAL_MS, () => {
            if (!this.connected) {
                return;
            }
            if (this.deps.now() - this.lastMessageAt >= SILENCE_TIMEOUT_MS) {
                this.drop('no message for 60 s');
                return;
            }
            if (this.deps.now() - this.connectedAt >= STABLE_AFTER_MS) {
                this.attempts = 0;
            }
            this.sendRecord({ type: 6 });
            this.schedulePing();
        });
    }

    /**
     * @param message - SignalR message
     */
    private sendRecord(message: Record<string, unknown>): void {
        try {
            this.socket?.send(`${JSON.stringify(message)}${RS}`);
        } catch (error) {
            this.drop(`send failed (${networkReason(error)})`);
        }
    }

    /**
     * Connection lost or unusable: close and reconnect with backoff.
     *
     * @param reason - Text for the log
     */
    private drop(reason: string): void {
        this.closeSocket();
        this.failed(reason);
    }

    /**
     * @param reason - Text for the log
     */
    private failed(reason: string): void {
        this.setConnected(false);
        if (this.stopped) {
            return;
        }
        this.attempts++;
        const delay = Math.min(MIN_RECONNECT_MS * 2 ** (this.attempts - 1), MAX_RECONNECT_MS);
        const message = `Easee stream: ${reason}; reconnect in ${Math.round(delay / 1000)} s (values are polled meanwhile)`;
        if (this.failureLogged) {
            this.deps.log.debug(message);
        } else {
            this.deps.log.info(message);
            this.failureLogged = true;
        }
        this.timer('reconnect', delay, () => void this.connect());
    }

    private closeSocket(): void {
        this.clearTimer('ping');
        this.clearTimer('handshake');
        const socket = this.socket;
        this.socket = undefined;
        this.handshakeDone = false;
        if (socket) {
            socket.onopen = null;
            socket.onmessage = null;
            socket.onclose = null;
            socket.onerror = null;
            try {
                socket.close(1000);
            } catch {
                // already closed
            }
        }
    }

    /**
     * @param connected - New state
     */
    private setConnected(connected: boolean): void {
        if (this.connected !== connected) {
            this.connected = connected;
            this.deps.onConnection(connected);
        }
    }

    /**
     * @param name - Timer slot
     * @param ms - Delay
     * @param callback - Work
     */
    private timer(name: string, ms: number, callback: () => void): void {
        this.clearTimer(name);
        const handle = this.deps.setTimeout(() => {
            this.timers.delete(name);
            if (!this.stopped) {
                callback();
            }
        }, ms);
        this.timers.set(name, handle);
    }

    /**
     * @param name - Timer slot
     */
    private clearTimer(name: string): void {
        const handle = this.timers.get(name);
        if (handle !== undefined) {
            this.deps.clearTimeout(handle);
            this.timers.delete(name);
        }
    }
}

/**
 * Cookie header from Set-Cookie answers (only name=value, for the load balancer stickiness).
 *
 * @param headers - Response headers
 */
export function cookieHeader(headers: Headers): string {
    const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    return list
        .map(cookie => cookie.split(';')[0].trim())
        .filter(pair => /^[\w.-]+=/.test(pair))
        .join('; ');
}
