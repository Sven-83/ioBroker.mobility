import { expect } from 'chai';
import type { FuelConfig } from './config';
import { FuelKeyRejectedError, FuelNetworkError, FuelRateLimitedError, FuelRefusedError } from './errors';
import {
    FuelService,
    MAX_BACKOFF_MS,
    REFUSED_PAUSE_MS,
    REQUEST_GAP_MS,
    type FuelClient,
    type FuelDeps,
} from './fuel-service';
import type { ObjectDefinition } from './objects';
import { PriceHistory } from './price-history';
import type { StationDetail, StationPrices } from './tankerkoenig';

const S1 = '00000000-0000-0000-0000-000000000001';
const S2 = '00000000-0000-0000-0000-000000000002';
const MIN = 60_000;

const CONFIG: FuelConfig = {
    enabled: true,
    apiKey: '00000000-0000-0000-0000-00000000000a',
    stations: [
        { id: S1, name: 'Nord', slot: 1 },
        { id: S2, name: 'Süd', slot: 2 },
    ],
    intervalMin: 10,
};

/** Deterministic timer queue: run() advances the clock to the next timer */
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

    /** Runs the next timer and lets the awaited work settle */
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

/** Lets pending promise chains finish (all fakes resolve immediately, so a few macrotasks suffice) */
async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) {
        await new Promise(resolve => setImmediate(resolve));
    }
}

/** Scriptable client that records request times */
class FakeClient implements FuelClient {
    public requests: { kind: 'prices' | 'detail'; at: number }[] = [];
    public pricesAnswer: () => Map<string, StationPrices> = () =>
        new Map([
            [S1, { status: 'open', e10: 1.75 }],
            [S2, { status: 'closed', e10: null }],
        ]);
    public pricesError: Error | undefined;
    public aborted = false;

    public constructor(private readonly clock: FakeClock) {}

    public getPrices(): Promise<Map<string, StationPrices>> {
        this.requests.push({ kind: 'prices', at: this.clock.time });
        return this.pricesError ? Promise.reject(this.pricesError) : Promise.resolve(this.pricesAnswer());
    }

    public getDetail(): Promise<StationDetail> {
        this.requests.push({ kind: 'detail', at: this.clock.time });
        return Promise.resolve({
            name: 'X',
            brand: 'BEISPIEL',
            street: 'Musterstraße',
            houseNumber: '1',
            postCode: '12345',
            place: 'Musterstadt',
            isOpen: true,
            wholeDay: false,
        });
    }

    public abort(): void {
        this.aborted = true;
    }
}

/**
 * @param overrides - Replaced dependencies
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- test helper, the inferred shape is the point
function setup(overrides: Partial<FuelDeps> = {}) {
    const clock = new FakeClock();
    const client = new FakeClient(clock);
    const states = new Map<string, ioBroker.StateValue>();
    const objects: ObjectDefinition[] = [];
    const logs: { level: string; message: string }[] = [];
    const connection: boolean[] = [];
    let saved: string | undefined;
    const removed: number[][] = [];
    const log = (level: string) => (message: string) => logs.push({ level, message });
    const deps: FuelDeps = {
        client,
        log: { error: log('error'), warn: log('warn'), info: log('info'), debug: log('debug') },
        now: () => clock.time,
        random: () => 0.5,
        setTimeout: (callback, ms) => clock.setTimeout(callback, ms),
        clearTimeout: handle => clock.clearTimeout(handle),
        ensureObjects: definitions => {
            objects.push(...definitions);
            return Promise.resolve();
        },
        removeStationsExcept: slots => {
            removed.push(slots);
            return Promise.resolve();
        },
        setState: (id, value) => {
            states.set(id, value);
            return Promise.resolve();
        },
        loadHistory: () => Promise.resolve(undefined),
        saveHistory: text => {
            saved = text;
            return Promise.resolve();
        },
        onConnection: connected => connection.push(connected),
        ...overrides,
    };
    const service = new FuelService(CONFIG, deps);
    return { clock, client, states, objects, logs, connection, removed, service, saved: () => saved };
}

describe('fuel/fuel-service', () => {
    it('creates objects, writes names and waits 5-65 s before the first request', async () => {
        const t = setup();
        await t.service.start();
        expect(t.objects.map(o => o.id)).to.include.members([
            'fuel',
            'fuel.ranking',
            'fuel.station1',
            'fuel.station2.e10',
        ]);
        expect(t.removed).to.deep.equal([[1, 2]]);
        expect(t.states.get('fuel.station1.name')).to.equal('Nord');
        expect(t.client.requests).to.have.length(0);
        expect(t.clock.pending()).to.deep.equal([35_000]); // 5 s + 0.5 * 60 s
    });

    it('writes prices, ranking and memory after a poll', async () => {
        const t = setup();
        await t.service.start();
        await t.clock.next();
        expect(t.client.requests.map(r => r.kind)).to.deep.equal(['prices']);
        expect(t.states.get('fuel.station1.e10')).to.equal(1.75);
        expect(t.states.get('fuel.station1.open')).to.equal(true);
        expect(t.states.get('fuel.station2.open')).to.equal(false);
        expect(t.states.get('fuel.station2.e10')).to.equal(null);
        expect(t.states.get('fuel.station1.rating')).to.equal('unknown'); // < 24 h recorded
        expect(t.states.get('fuel.cheapestStation')).to.equal('Nord');
        expect(t.states.get('fuel.cheapestPrice')).to.equal(1.75);
        expect(JSON.parse(String(t.states.get('fuel.ranking')))).to.deep.equal([
            { station: 'station1', name: 'Nord', price: 1.75, rating: 'unknown' },
        ]);
        expect(t.connection).to.deep.equal([true]);
        const memory = PriceHistory.parse(t.saved()).history;
        expect(memory.points(PriceHistory.key(S1, 'e10'))).to.have.length(1);
        expect(memory.points(PriceHistory.key(S2, 'e10'))).to.deep.equal([[t.clock.time, null]]);
    });

    it('keeps at least 61 s between all requests (prices + details)', async () => {
        const t = setup();
        await t.service.start();
        for (let i = 0; i < 8; i++) {
            await t.clock.next();
        }
        const times = t.client.requests.map(r => r.at);
        expect(t.client.requests.map(r => r.kind).slice(0, 3)).to.deep.equal(['prices', 'detail', 'detail']);
        for (let i = 1; i < times.length; i++) {
            expect(times[i] - times[i - 1]).to.be.at.least(REQUEST_GAP_MS);
        }
        expect(t.states.get('fuel.station1.address')).to.equal('Musterstraße 1, 12345 Musterstadt');
        expect(t.states.get('fuel.station2.brand')).to.equal('BEISPIEL');
    });

    it('polls again after interval + random offset', async () => {
        const t = setup();
        await t.service.start();
        await t.clock.next(); // prices
        // the next price poll is scheduled at 10 min + 30 s; details come in between
        const pricesAt = t.client.requests[0].at;
        while (t.client.requests.filter(r => r.kind === 'prices').length < 2) {
            await t.clock.next();
        }
        const second = t.client.requests.filter(r => r.kind === 'prices')[1].at;
        expect(second - pricesAt).to.equal(10 * MIN + 30_000);
    });

    it('stops for good when the key is rejected', async () => {
        const t = setup();
        await t.service.start();
        t.client.pricesError = new FuelKeyRejectedError('prices.php: API key rejected');
        await t.clock.next();
        expect(t.logs.some(l => l.level === 'error' && l.message.includes('API key rejected'))).to.equal(true);
        expect(t.clock.pending()).to.deep.equal([]);
        expect(t.connection).to.deep.equal([false]);
    });

    it('backs off on network errors, warns once and reports the recovery', async () => {
        const t = setup();
        await t.service.start();
        t.client.pricesError = new FuelNetworkError('prices.php: no answer (ENOTFOUND)');
        await t.clock.next();
        expect(t.clock.pending()).to.deep.equal([10 * MIN + 30_000]);
        await t.clock.next();
        expect(t.clock.pending()).to.deep.equal([20 * MIN + 30_000]);
        await t.clock.next();
        await t.clock.next();
        await t.clock.next();
        await t.clock.next();
        expect(t.clock.pending()[0]).to.equal(MAX_BACKOFF_MS + 30_000);
        expect(t.logs.filter(l => l.level === 'warn')).to.have.length(1);

        t.client.pricesError = undefined;
        await t.clock.next();
        expect(t.logs.some(l => l.level === 'info' && l.message.includes('reachable again'))).to.equal(true);
        expect(t.connection.at(-1)).to.equal(true);
    });

    it('pauses one hour after an ok:false answer', async () => {
        const t = setup();
        await t.service.start();
        t.client.pricesError = new FuelRefusedError('prices.php: request refused (Wartungsarbeiten)');
        await t.clock.next();
        expect(t.clock.pending()).to.deep.equal([REFUSED_PAUSE_MS + 30_000]);
        expect(t.logs.filter(l => l.level === 'warn')).to.have.length(1);
    });

    it('respects the wait of a rate limit', async () => {
        const t = setup();
        await t.service.start();
        t.client.pricesError = new FuelRateLimitedError('too many requests', 45 * MIN);
        await t.clock.next();
        expect(t.clock.pending()).to.deep.equal([45 * MIN + 30_000]);
    });

    it('warns once about a station the API does not know', async () => {
        const t = setup();
        t.client.pricesAnswer = () => new Map([[S1, { status: 'open', e10: 1.75 }]]);
        await t.service.start();
        await t.clock.next();
        while (t.client.requests.filter(r => r.kind === 'prices').length < 2) {
            await t.clock.next();
        }
        expect(t.states.get('fuel.station2.status')).to.equal('not found');
        expect(t.logs.filter(l => l.message.includes('unknown to Tankerkoenig'))).to.have.length(1);
    });

    it('stop() clears timers and aborts the client', async () => {
        const t = setup();
        await t.service.start();
        t.service.stop();
        expect(t.clock.pending()).to.deep.equal([]);
        expect(t.client.aborted).to.equal(true);
    });

    it('starts with an empty memory if the file is broken', async () => {
        const t = setup({ loadHistory: () => Promise.resolve('{broken') });
        await t.service.start();
        expect(t.logs.some(l => l.level === 'warn' && l.message.includes('memory'))).to.equal(true);
    });
});
