import { expect } from 'chai';
import { EaseeAuthError } from './errors';
import type { RawObservation } from './observations';
import {
    EaseeStream,
    MIN_RECONNECT_MS,
    PING_INTERVAL_MS,
    SILENCE_TIMEOUT_MS,
    cookieHeader,
    type SocketLike,
    type StreamDeps,
} from './stream';

// placeholders only
const A = 'EH000000';
const B = 'ES000000';
const TOKEN = 'token-placeholder';
const HUB = 'https://hub.example.invalid/hubs/products';
const RS = '\u001e';

/** Deterministic timer queue */
class FakeClock {
    public time = 1_000_000;
    private timers: { at: number; callback: () => void; id: number }[] = [];
    private nextId = 1;

    public setTimeout(callback: () => void, ms: number): number {
        const id = this.nextId++;
        this.timers.push({ at: this.time + ms, callback, id });
        return id;
    }

    public clearTimeout(id: unknown): void {
        this.timers = this.timers.filter(timer => timer.id !== id);
    }

    public pending(): number[] {
        return this.timers.map(timer => timer.at - this.time).sort((a, b) => a - b);
    }

    public async next(): Promise<void> {
        this.timers.sort((a, b) => a.at - b.at);
        const timer = this.timers.shift();
        if (!timer) {
            throw new Error('no timer pending');
        }
        this.time = timer.at;
        timer.callback();
        await settle();
    }
}

/** Lets pending promise chains finish */
async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setImmediate(resolve));
    }
}

class FakeSocket implements SocketLike {
    public sent: string[] = [];
    public closed = false;
    public onopen: ((event: unknown) => void) | null = null;
    public onmessage: ((event: { data: unknown }) => void) | null = null;
    public onclose: ((event: { code: number; reason: string }) => void) | null = null;
    public onerror: ((event: unknown) => void) | null = null;

    public constructor(
        public readonly url: string,
        public readonly headers: Record<string, string>,
    ) {}

    public send(data: string): void {
        this.sent.push(data);
    }

    public close(): void {
        this.closed = true;
    }

    /** Parsed records sent by the client */
    public records(): Record<string, unknown>[] {
        return this.sent
            .join('')
            .split(RS)
            .filter(Boolean)
            .map(r => JSON.parse(r) as Record<string, unknown>);
    }

    public serverSends(...messages: unknown[]): void {
        this.onmessage?.({ data: messages.map(m => JSON.stringify(m) + RS).join('') });
    }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- test helper
function setup(negotiate: () => Response = () => negotiateOk()) {
    const clock = new FakeClock();
    const sockets: FakeSocket[] = [];
    const observations: { serial: string; observation: RawObservation }[] = [];
    const connection: boolean[] = [];
    const logs: { level: string; message: string }[] = [];
    const fetches: { url: string; init?: RequestInit }[] = [];
    let tokenError: Error | undefined;
    const log = (level: string) => (message: string) => logs.push({ level, message });
    const deps: StreamDeps = {
        getToken: () => (tokenError ? Promise.reject(tokenError) : Promise.resolve(TOKEN)),
        createSocket: (url, headers) => {
            const socket = new FakeSocket(url, headers);
            sockets.push(socket);
            return socket;
        },
        fetch: (url, init) => {
            fetches.push({ url, init });
            return Promise.resolve(negotiate());
        },
        log: { error: log('error'), warn: log('warn'), info: log('info'), debug: log('debug') },
        now: () => clock.time,
        setTimeout: (callback, ms) => clock.setTimeout(callback, ms),
        clearTimeout: handle => clock.clearTimeout(handle),
        onObservation: (serial, observation) => observations.push({ serial, observation }),
        onConnection: connected => connection.push(connected),
    };
    const stream = new EaseeStream(deps, HUB);
    return {
        clock,
        sockets,
        observations,
        connection,
        logs,
        fetches,
        stream,
        failToken: (error: Error) => (tokenError = error),
        last: () => sockets[sockets.length - 1],
    };
}

/** Typical negotiate answer with a load balancer cookie */
function negotiateOk(): Response {
    const headers = new Headers();
    headers.append('set-cookie', 'AWSALB=abc; Path=/; Expires=Thu, 12 Nov 2026 10:00:00 GMT');
    headers.append('set-cookie', 'AWSALBCORS=def; Path=/; SameSite=None; Secure');
    return new Response(JSON.stringify({ negotiateVersion: 1, connectionId: 'cid', connectionToken: 'ctok' }), {
        status: 200,
        headers,
    });
}

/**
 * Opens the socket and completes the handshake.
 *
 * @param t - Test setup
 */
async function connect(t: ReturnType<typeof setup>): Promise<FakeSocket> {
    await settle();
    const socket = t.last();
    socket.onopen?.({});
    socket.serverSends({});
    return socket;
}

describe('easee/stream', () => {
    it('negotiates, passes cookie and token, handshakes and subscribes every charger', async () => {
        const t = setup();
        t.stream.start([A, B]);
        const socket = await connect(t);

        expect(t.fetches[0].url).to.equal(`${HUB}/negotiate?negotiateVersion=1`);
        expect((t.fetches[0].init?.headers as Record<string, string>).Authorization).to.equal(`Bearer ${TOKEN}`);
        const url = new URL(socket.url);
        expect(url.protocol).to.equal('wss:');
        expect(url.searchParams.get('id')).to.equal('ctok');
        expect(url.searchParams.get('access_token')).to.equal(TOKEN);
        expect(socket.headers.Cookie).to.equal('AWSALB=abc; AWSALBCORS=def');

        const records = socket.records();
        expect(records[0]).to.deep.equal({ protocol: 'json', version: 1 });
        expect(records.slice(1)).to.deep.equal([
            { type: 1, invocationId: '1', target: 'SubscribeWithCurrentState', arguments: [A, true] },
            { type: 1, invocationId: '2', target: 'SubscribeWithCurrentState', arguments: [B, true] },
        ]);
        expect(t.connection).to.deep.equal([true]);
        expect(t.stream.isConnected()).to.equal(true);
    });

    it('opens the WebSocket directly when negotiate is not offered', async () => {
        const t = setup(() => new Response('', { status: 404 }));
        t.stream.start([A]);
        await settle();
        const url = new URL(t.last().url);
        expect(url.searchParams.get('id')).to.equal(null);
        expect(url.searchParams.get('access_token')).to.equal(TOKEN);
    });

    it('passes ProductUpdate values on (strings, frames split anywhere)', async () => {
        const t = setup();
        t.stream.start([A]);
        const socket = await connect(t);
        const update = JSON.stringify({
            type: 1,
            target: 'ProductUpdate',
            arguments: [{ mid: A, dataType: 4, id: 109, timestamp: '2026-11-05T10:00:00Z', value: '3' }],
        });
        socket.onmessage?.({ data: update.slice(0, 20) });
        expect(t.observations).to.have.length(0);
        socket.onmessage?.({ data: update.slice(20) + RS });
        socket.serverSends(
            { type: 1, target: 'ProductUpdate', arguments: [{ mid: 'UNKNOWN1', id: 109, value: '1' }] },
            { type: 1, target: 'CommandResponse', arguments: [{ mid: A }] },
            { type: 6 },
        );
        expect(t.observations).to.deep.equal([
            { serial: A, observation: { id: 109, value: '3', timestamp: '2026-11-05T10:00:00Z' } },
        ]);
    });

    it('pings and reconnects with backoff after 60 s of silence', async () => {
        const t = setup();
        t.stream.start([A]);
        const first = await connect(t);
        await t.clock.next(); // ping
        expect(first.records().at(-1)).to.deep.equal({ type: 6 });
        for (let ms = PING_INTERVAL_MS; ms < SILENCE_TIMEOUT_MS; ms += PING_INTERVAL_MS) {
            await t.clock.next();
        }
        expect(first.closed).to.equal(true);
        expect(t.connection).to.deep.equal([true, false]);
        expect(t.clock.pending()).to.deep.equal([MIN_RECONNECT_MS]);
        await t.clock.next();
        expect(t.sockets).to.have.length(2);
        // the second attempt fails too -> double wait, only one info line in the log
        t.last().onclose?.({ code: 1006, reason: '' });
        expect(t.clock.pending()).to.deep.equal([2 * MIN_RECONNECT_MS]);
        expect(t.logs.filter(l => l.level === 'info' && l.message.includes('reconnect'))).to.have.length(1);
    });

    it('drops the connection when the server sends close', async () => {
        const t = setup();
        t.stream.start([A]);
        const socket = await connect(t);
        socket.serverSends({ type: 7, error: 'Connection closed with an error.', allowReconnect: true });
        expect(socket.closed).to.equal(true);
        expect(t.stream.isConnected()).to.equal(false);
    });

    it('drops after a refused handshake and on a missing handshake answer', async () => {
        const t = setup();
        t.stream.start([A]);
        await settle();
        const socket = t.last();
        socket.onopen?.({});
        socket.serverSends({ error: 'Requested protocol is not available' });
        expect(socket.closed).to.equal(true);
        expect(t.connection).to.deep.equal([]);

        await t.clock.next(); // reconnect
        t.last().onopen?.({});
        await t.clock.next(); // handshake timeout
        expect(t.last().closed).to.equal(true);
    });

    it('never retries after a rejected login', async () => {
        const t = setup();
        t.failToken(new EaseeAuthError('login rejected (HTTP 400)'));
        t.stream.start([A]);
        await settle();
        expect(t.sockets).to.have.length(0);
        expect(t.clock.pending()).to.deep.equal([]);
    });

    it('resubscribes one charger on request', async () => {
        const t = setup();
        t.stream.start([A, B]);
        const socket = await connect(t);
        t.stream.resubscribe(B);
        t.stream.resubscribe('UNKNOWN1');
        expect(socket.records().at(-1)).to.deep.include({ target: 'SubscribeWithCurrentState', arguments: [B, true] });
        expect(socket.records()).to.have.length(4);
    });

    it('never logs the token', async () => {
        const t = setup(() => new Response('', { status: 500 }));
        t.stream.start([A]);
        await settle();
        expect(t.logs.length).to.be.greaterThan(0);
        for (const entry of t.logs) {
            expect(entry.message).not.to.contain(TOKEN);
            expect(entry.message).not.to.contain('hub.example');
        }
    });

    it('stop closes everything', async () => {
        const t = setup();
        t.stream.start([A]);
        const socket = await connect(t);
        t.stream.stop();
        expect(socket.closed).to.equal(true);
        expect(t.clock.pending()).to.deep.equal([]);
        expect(t.connection).to.deep.equal([true, false]);
    });

    it('cookieHeader keeps name=value pairs only', () => {
        const headers = new Headers();
        headers.append('set-cookie', 'A=1; Path=/');
        headers.append('set-cookie', 'broken');
        expect(cookieHeader(headers)).to.equal('A=1');
    });
});
