import { expect } from 'chai';
import { EaseeAuthError, EaseeNetworkError, EaseeRateLimitedError } from './errors';
import type { ChargeSession } from './sessions';
import {
    AFTER_UNPLUG_MS,
    BACKFILL_WINDOW_MS,
    EaseeSessions,
    FIRST_REQUEST_MS,
    RECENT_WINDOW_MS,
    REFRESH_MS,
    REQUEST_GAP_MS,
    type SessionDeps,
} from './sessions-sync';

const NOW = Date.parse('2026-11-14T11:00:00Z');
const DAY = 86_400_000;
const A = 'EH000000';
const B = 'ES000000';

/** Deterministic timer queue */
class FakeClock {
    public time = NOW;
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

    /**
     * Runs timers until the given time
     *
     * @param t - Target time
     */
    public async until(t: number): Promise<void> {
        for (;;) {
            this.timers.sort((a, b) => a.at - b.at);
            if (!this.timers[0] || this.timers[0].at > t) {
                this.time = t;
                return;
            }
            await this.next();
        }
    }
}

async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setImmediate(resolve));
    }
}

/**
 * @param id - ID
 * @param start - Start
 * @param kwh - kWh
 */
function session(id: number, start: number, kwh: number): ChargeSession {
    return { id, start, end: start + 3_600_000, kwh, seconds: 3600, easeeCost: null, complete: true };
}

interface Request {
    serial: string;
    from: number;
    to: number;
    at: number;
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- test helper
function setup(
    answer: (r: Request) => ChargeSession[] | Error,
    files: Record<number, string> = {},
    since: number | null = null,
) {
    const clock = new FakeClock();
    const requests: Request[] = [];
    const states = new Map<string, ioBroker.StateValue>();
    const logs: string[] = [];
    const saved: Record<number, string> = {};
    const log = (level: string) => (m: string) => logs.push(`${level}: ${m}`);
    const deps: SessionDeps = {
        getSessions: (serial, from, to) => {
            const r = { serial, from, to, at: clock.time };
            requests.push(r);
            const result = answer(r);
            return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
        },
        log: { error: log('error'), warn: log('warn'), info: log('info'), debug: log('debug') },
        now: () => clock.time,
        setTimeout: (cb, ms) => clock.setTimeout(cb, ms),
        clearTimeout: h => clock.clearTimeout(h),
        ensureObjects: () => Promise.resolve(),
        setState: (id, value) => {
            states.set(id, value);
            return Promise.resolve();
        },
        load: slot => Promise.resolve(files[slot]),
        save: (slot, text) => {
            saved[slot] = text;
            return Promise.resolve();
        },
    };
    const sync = new EaseeSessions(0.4, deps, since);
    return { clock, requests, states, logs, saved, sync };
}

const CHARGERS = [
    { slot: 1, serial: A, name: 'Carport' },
    { slot: 2, serial: B, name: 'Garage' },
];

describe('easee/sessions-sync', () => {
    it('loads the past year by year with 6 min between requests and stops at an empty year', async () => {
        const { clock, requests, states, saved, sync, logs } = setup(r => {
            if (r.serial === B) {
                return []; // charger never used
            }
            // sessions only in the last two years
            return r.from >= NOW - 2 * BACKFILL_WINDOW_MS - DAY
                ? [
                      session(Math.round(r.from / DAY) * 2, r.from + DAY, 20),
                      session(Math.round(r.to / DAY) * 2 + 1, r.to - DAY, 10),
                  ]
                : [];
        });
        await sync.start(CHARGERS);
        expect(requests).to.have.length(0);
        expect(clock.pending()[0]).to.equal(FIRST_REQUEST_MS);
        await clock.until(NOW + FIRST_REQUEST_MS + 5 * REQUEST_GAP_MS);

        expect(requests.map(r => r.serial)).to.deep.equal([A, B, A, A]);
        for (let i = 1; i < requests.length; i++) {
            expect(requests[i].at - requests[i - 1].at).to.be.at.least(REQUEST_GAP_MS);
        }
        expect(requests[0].to - requests[0].from).to.equal(BACKFILL_WINDOW_MS);
        expect(requests[2].to).to.equal(requests[0].from); // next year back, no gap
        expect(sync.pending()).to.deep.equal([]);

        const store1 = JSON.parse(saved[1]);
        expect(store1.backfillDone).to.equal(true);
        expect(store1.sessions).to.have.length(4);
        expect(JSON.parse(saved[2]).backfillDone).to.equal(true);
        expect(states.get('easee.charger1.history.sessionCount')).to.equal(4);
        expect(states.get('easee.charger2.history.sessionCount')).to.equal(0);
        expect(states.get('easee.history.sessionCount')).to.equal(4);
        expect(states.get('easee.charger1.history.yearEnergy')).to.be.a('number');
        expect(JSON.parse(String(states.get('easee.history.months')))).to.have.length(13);
        expect(logs.filter(l => l.startsWith('info'))).to.have.length(2);
    });

    it('only reads the last 30 days when the past is already loaded, then every 6 h', async () => {
        const done = JSON.stringify({ v: 1, backfilledTo: 0, backfillDone: true, sessions: [] });
        const { clock, requests, sync } = setup(() => [], { 1: done, 2: done });
        await sync.start(CHARGERS);
        await clock.until(NOW + FIRST_REQUEST_MS + REQUEST_GAP_MS);
        expect(requests).to.have.length(2);
        expect(requests[0].to - requests[0].from).to.equal(RECENT_WINDOW_MS);
        await clock.until(NOW + REFRESH_MS + 2 * REQUEST_GAP_MS);
        expect(requests).to.have.length(4);
    });

    it('reads again 2 min after the car was unplugged', async () => {
        const done = JSON.stringify({ v: 1, backfilledTo: 0, backfillDone: true, sessions: [] });
        let answer: ChargeSession[] = [];
        const { clock, requests, states, sync } = setup(() => answer, { 1: done });
        await sync.start([CHARGERS[0]]);
        await clock.until(NOW + FIRST_REQUEST_MS);
        expect(requests).to.have.length(1);

        await clock.until(NOW + 30 * 60_000);
        answer = [session(7, clock.time - 3 * 3_600_000, 24.8)];
        sync.carUnplugged(1);
        sync.carUnplugged(9); // unknown slot: ignored
        await clock.until(clock.time + AFTER_UNPLUG_MS);
        expect(requests).to.have.length(2);
        expect(states.get('easee.charger1.history.monthEnergy')).to.equal(24.8);
        expect(states.get('easee.charger1.history.monthCost')).to.equal(9.92);
        expect(JSON.parse(String(states.get('easee.history.lastSession')))).to.deep.include({ kwh: 24.8 });
    });

    it('keeps the 6 min gap for an unplug right after a request', async () => {
        const done = JSON.stringify({ v: 1, backfilledTo: 0, backfillDone: true, sessions: [] });
        const { clock, requests, sync } = setup(() => [], { 1: done });
        await sync.start([CHARGERS[0]]);
        await clock.until(NOW + FIRST_REQUEST_MS);
        sync.carUnplugged(1);
        await clock.until(NOW + FIRST_REQUEST_MS + REQUEST_GAP_MS - 1);
        expect(requests).to.have.length(1);
        await clock.until(NOW + FIRST_REQUEST_MS + REQUEST_GAP_MS);
        expect(requests).to.have.length(2);
    });

    it('backs off after errors and waits for Retry-After', async () => {
        let fail: Error | undefined = new EaseeNetworkError('down');
        const { clock, requests, sync, logs } = setup(() => fail ?? []);
        await sync.start([CHARGERS[0]]);
        await clock.until(NOW + FIRST_REQUEST_MS);
        expect(requests).to.have.length(1);
        expect(clock.pending()[0]).to.equal(REQUEST_GAP_MS);
        fail = new EaseeRateLimitedError('slow down', 60 * 60_000);
        await clock.next();
        expect(requests).to.have.length(2);
        expect(clock.pending()[0]).to.equal(60 * 60_000);
        expect(logs.some(l => l.startsWith('warn'))).to.equal(false);
        fail = undefined;
        await clock.next();
        expect(requests).to.have.length(3);
        expect(sync.pending()).to.deep.equal([]);
    });

    it('stops on a rejected login and after stop()', async () => {
        const { clock, requests, sync } = setup(() => new EaseeAuthError('rejected'));
        await sync.start(CHARGERS);
        await clock.until(NOW + FIRST_REQUEST_MS);
        expect(requests).to.have.length(1);
        expect(clock.pending()).to.deep.equal([]);

        const other = setup(() => []);
        await other.sync.start(CHARGERS);
        other.sync.stop();
        expect(other.clock.pending()).to.deep.equal([]);
        other.sync.carUnplugged(1);
        expect(other.clock.pending()).to.deep.equal([]);
    });

    it('keeps the stored sessions when the file is read back', async () => {
        const stored = JSON.stringify({
            v: 1,
            backfilledTo: 0,
            backfillDone: true,
            sessions: [session(1, NOW - DAY, 12)],
        });
        const { states, sync } = setup(() => [], { 1: stored });
        await sync.start([CHARGERS[0]]);
        expect(states.get('easee.charger1.history.sessionCount')).to.equal(1);
        expect(states.get('easee.charger1.history.monthEnergy')).to.equal(12);
    });

    it('only loads and counts sessions from the start date on', async () => {
        const since = Date.parse('2026-10-01T00:00:00+02:00');
        const old = session(1, since - 10 * DAY, 50); // stored earlier, before the start date
        const stored = JSON.stringify({ v: 1, backfilledTo: null, backfillDone: false, sessions: [old] });
        const { clock, requests, states, saved, sync } = setup(
            r => [session(2, r.from + DAY, 20)],
            { 1: stored },
            since,
        );
        await sync.start([CHARGERS[0]]);
        await clock.until(NOW + FIRST_REQUEST_MS + 3 * REQUEST_GAP_MS);
        expect(requests).to.have.length(1); // one request covers 1.10. .. today
        expect(requests[0].from).to.equal(since);
        expect(JSON.parse(saved[1]).backfillDone).to.equal(true);
        expect(JSON.parse(saved[1]).sessions).to.have.length(2); // nothing deleted
        expect(states.get('easee.charger1.history.sessionCount')).to.equal(1);
        expect(states.get('easee.charger1.history.yearEnergy')).to.equal(20);
        expect(states.get('easee.charger1.history.oldestSession')).to.equal(since + DAY);
    });

    it('continues loading when the start date is moved back', async () => {
        const since = Date.parse('2026-06-01T00:00:00+02:00');
        const stored = JSON.stringify({
            v: 1,
            backfilledTo: Date.parse('2026-10-01T00:00:00+02:00'),
            backfillDone: true,
            sessions: [],
        });
        const { clock, requests, sync } = setup(() => [], { 1: stored }, since);
        await sync.start([CHARGERS[0]]);
        await clock.until(NOW + FIRST_REQUEST_MS);
        expect(requests).to.have.length(1);
        expect(requests[0].from).to.equal(since);
        expect(requests[0].to).to.equal(Date.parse('2026-10-01T00:00:00+02:00'));
    });
});
