import { expect } from 'chai';
import type { EaseeConfig } from './config';
import type { ChargeCommand, ChargerInfo } from './easee-client';
import {
    COMMAND_GAP_MS,
    EaseeService,
    MAX_BACKOFF_MS,
    PUSH_APPLY_DELAY_MS,
    RESUBSCRIBE_AFTER_COMMAND_MS,
    STREAM_POLL_MS,
    merge,
    type EaseeApi,
    type EaseeDeps,
    type StreamControl,
} from './easee-service';
import { EaseeAuthError, EaseeNetworkError, EaseeRateLimitedError } from './errors';
import { OBS, OP_MODE, type RawObservation } from './observations';

const CONFIG: EaseeConfig = {
    enabled: true,
    userName: 'user@example.invalid',
    password: 'x',
    intervalSec: 60,
    pricePerKwh: 0.4,
    stream: false,
    sessionsFrom: null,
    chargerNames: [],
};
const A = 'EH000000';
const B = 'ES000000';
const TS = '2026-11-05T10:00:00.000Z';

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

/**
 * @param opMode - Op mode
 * @param extra - More observations
 */
function obs(opMode: number, extra: Partial<Record<number, unknown>> = {}): RawObservation[] {
    const list: RawObservation[] = [
        { id: OBS.opMode, value: opMode, timestamp: TS },
        { id: OBS.connectedToCloud, value: true, timestamp: TS },
        { id: OBS.sessionEnergy, value: 10, timestamp: TS },
    ];
    for (const [id, value] of Object.entries(extra)) {
        list.push({ id: Number(id), value, timestamp: TS });
    }
    return list;
}

class FakeApi implements EaseeApi {
    public chargers: ChargerInfo[] = [
        { serial: A, name: 'Carport' },
        { serial: B, name: 'Garage' },
    ];
    public observations = new Map<string, RawObservation[]>([
        [A, obs(OP_MODE.readyToCharge)],
        [B, obs(OP_MODE.disconnected)],
    ]);
    public error: Error | undefined;
    public commandError: Error | undefined;
    public reads: string[] = [];
    public commands: { serial: string; command: ChargeCommand }[] = [];
    public aborted = false;

    public getChargers(): Promise<ChargerInfo[]> {
        return this.error ? Promise.reject(this.error) : Promise.resolve(this.chargers);
    }

    public getObservations(serial: string): Promise<RawObservation[]> {
        this.reads.push(serial);
        return this.error ? Promise.reject(this.error) : Promise.resolve(this.observations.get(serial) ?? []);
    }

    public command(serial: string, command: ChargeCommand): Promise<void> {
        this.commands.push({ serial, command });
        return this.commandError ? Promise.reject(this.commandError) : Promise.resolve();
    }

    public abort(): void {
        this.aborted = true;
    }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- test helper
function setup(config: EaseeConfig = CONFIG) {
    const clock = new FakeClock();
    const api = new FakeApi();
    const states = new Map<string, ioBroker.StateValue>();
    const logs: { level: string; message: string }[] = [];
    const connection: boolean[] = [];
    const removed: number[][] = [];
    const objects: string[] = [];
    const writes: string[] = [];
    const log = (level: string) => (message: string) => logs.push({ level, message });
    const deps: EaseeDeps = {
        client: api,
        log: { error: log('error'), warn: log('warn'), info: log('info'), debug: log('debug') },
        now: () => clock.time,
        random: () => 0,
        setTimeout: (callback, ms) => clock.setTimeout(callback, ms),
        clearTimeout: handle => clock.clearTimeout(handle),
        ensureObjects: definitions => {
            objects.push(...definitions.map(d => d.id));
            return Promise.resolve();
        },
        removeChargersExcept: slots => {
            removed.push(slots);
            return Promise.resolve();
        },
        setState: (id, value) => {
            writes.push(id);
            states.set(id, value);
            return Promise.resolve();
        },
        onConnection: connected => connection.push(connected),
    };
    const service = new EaseeService(config, deps);
    return { clock, api, states, logs, connection, removed, objects, writes, service };
}

describe('easee/service', () => {
    it('hands the chargers to the session part and reports an unplugged car', async () => {
        const t = setup();
        const started: number[][] = [];
        const unplugged: number[] = [];
        t.service.attachSessions({
            start: chargers => {
                started.push(chargers.map(c => c.slot));
                return Promise.resolve();
            },
            carUnplugged: slot => unplugged.push(slot),
            stop: () => undefined,
        });
        t.service.start();
        await t.clock.next();
        expect(started).to.deep.equal([[1, 2]]);
        expect(unplugged).to.deep.equal([]); // charger 2 was never plugged in
        t.api.observations.set(A, obs(OP_MODE.disconnected));
        await t.service.poll();
        expect(unplugged).to.deep.equal([1]);
        await t.service.poll();
        expect(unplugged).to.deep.equal([1]);
    });

    it('finds the chargers, creates slots and writes the values', async () => {
        const t = setup();
        t.service.start();
        await t.clock.next();
        expect(t.service.slots()).to.deep.equal([1, 2]);
        expect(t.removed).to.deep.equal([[1, 2]]);
        expect(t.objects).to.include('easee.charger2.sessionCost');
        expect(t.states.get('easee.charger1.name')).to.equal('Carport');
        expect(t.states.get('easee.charger1.status')).to.equal('Ready to charge');
        expect(t.states.get('easee.charger1.carConnected')).to.equal(true);
        expect(t.states.get('easee.charger2.carConnected')).to.equal(false);
        expect(t.states.get('easee.charger1.sessionCost')).to.equal(4);
        expect(t.states.get('easee.charger1.charge')).to.equal(false);
        expect(t.api.reads).to.deep.equal([A, B]);
        expect(t.connection.at(-1)).to.equal(true);
        expect(t.clock.pending()).to.deep.equal([60_000]);
    });

    it('skips cost states without a price', async () => {
        const t = setup({ ...CONFIG, pricePerKwh: 0 });
        t.service.start();
        await t.clock.next();
        expect(t.objects).not.to.include('easee.charger1.sessionCost');
        expect(t.states.has('easee.charger1.sessionCost')).to.equal(false);
    });

    it('uses resume/pause without authorization and start/stop with it', async () => {
        const t = setup();
        t.service.start();
        await t.clock.next();
        await t.service.setCharging(1, true);
        expect(t.api.commands.at(-1)).to.deep.equal({ serial: A, command: 'resume_charging' });
        expect(t.states.get('easee.charger1.charge')).to.equal(true);

        t.api.observations.set(A, obs(OP_MODE.charging, { [OBS.authorizationRequired]: true }));
        t.service.requestPoll(0);
        await t.clock.next();
        t.clock.time += COMMAND_GAP_MS;
        await t.service.setCharging(1, false);
        expect(t.api.commands.at(-1)).to.deep.equal({ serial: A, command: 'stop_charging' });
    });

    it('refuses to start without a car and too fast commands', async () => {
        const t = setup();
        t.service.start();
        await t.clock.next();
        await t.service.setCharging(2, true);
        expect(t.api.commands).to.have.length(0);
        expect(t.states.get('easee.charger2.charge')).to.equal(false);
        expect(t.logs.some(l => l.message.includes('no car plugged in'))).to.equal(true);

        await t.service.setCharging(1, true);
        await t.service.setCharging(1, false);
        expect(t.api.commands).to.have.length(1);
        expect(t.states.get('easee.charger1.charge')).to.equal(false);
    });

    it('reads the values again after a command and does not flip the switch back too early', async () => {
        const t = setup();
        t.service.start();
        await t.clock.next();
        await t.service.setCharging(1, true);
        expect(t.clock.pending()).to.deep.equal([10_000, 40_000, 60_000]);
        await t.clock.next(); // after-command timer -> requestPoll(0)
        await t.clock.next(); // the poll
        expect(t.api.reads).to.have.length(4);
        expect(t.states.get('easee.charger1.charge')).to.equal(true); // still ready, but within settle time
    });

    it('reports a failed command and restores the switch', async () => {
        const t = setup();
        t.service.start();
        await t.clock.next();
        t.api.commandError = new EaseeNetworkError('resume_charging: no answer (ETIMEDOUT)');
        await t.service.setCharging(1, true);
        expect(t.states.get('easee.charger1.charge')).to.equal(false);
        expect(t.logs.some(l => l.level === 'warn' && l.message.includes('failed'))).to.equal(true);
    });

    it('backs off on errors, waits for 429 and logs the outage once', async () => {
        const t = setup();
        t.service.start();
        await t.clock.next();
        t.api.error = new EaseeNetworkError('observations: no answer (ENOTFOUND)');
        await t.clock.next();
        expect(t.clock.pending()).to.deep.equal([60_000]);
        await t.clock.next();
        expect(t.clock.pending()).to.deep.equal([120_000]);
        t.api.error = new EaseeRateLimitedError('observations: too many requests', 20 * 60_000);
        await t.clock.next();
        expect(t.clock.pending()).to.deep.equal([20 * 60_000]);
        await t.clock.next();
        await t.clock.next();
        expect(t.clock.pending()[0]).to.be.at.most(MAX_BACKOFF_MS);
        expect(t.logs.filter(l => l.level === 'warn')).to.have.length(1);
        t.api.error = undefined;
        await t.clock.next();
        expect(t.logs.some(l => l.message.includes('reachable again'))).to.equal(true);
        expect(t.clock.pending()).to.deep.equal([60_000]);
    });

    it('stops completely when the login is rejected', async () => {
        const t = setup();
        t.api.error = new EaseeAuthError('login rejected (HTTP 400) - check user name and password');
        t.service.start();
        await t.clock.next();
        expect(t.logs.some(l => l.level === 'error')).to.equal(true);
        expect(t.clock.pending()).to.deep.equal([]);
        expect(t.api.aborted).to.equal(true);
        expect(t.connection.at(-1)).to.equal(false);
    });

    it('retries discovery and checks hourly when the account has no chargers', async () => {
        const t = setup();
        t.api.chargers = [];
        t.service.start();
        await t.clock.next();
        expect(t.clock.pending()).to.deep.equal([3_600_000]);
        expect(t.service.slots()).to.deep.equal([]);
    });

    it('a manual refresh replaces the pending poll', async () => {
        const t = setup();
        t.service.start();
        await t.clock.next();
        t.service.requestPoll(0);
        expect(t.clock.pending()).to.deep.equal([0]);
        await t.clock.next();
        expect(t.api.reads).to.have.length(4);
        expect(t.clock.pending()).to.deep.equal([60_000]);
    });

    it('writes only changed values', async () => {
        const t = setup();
        t.service.start();
        await t.clock.next();
        const before = t.writes.length;
        await t.clock.next(); // same values again
        expect(t.writes.length).to.equal(before);
    });
});

class FakeStream implements StreamControl {
    public started: string[] = [];
    public resubscribed: string[] = [];
    public connected = false;
    public stopped = false;

    public start(serials: string[]): void {
        this.started = serials;
    }

    public stop(): void {
        this.stopped = true;
    }

    public resubscribe(serial: string): void {
        this.resubscribed.push(serial);
    }

    public isConnected(): boolean {
        return this.connected;
    }
}

describe('easee/service charger selection', () => {
    /**
     * An account that sees many chargers
     *
     * @param api - Fake client to fill
     */
    function carPark(api: FakeApi): void {
        api.chargers = Array.from({ length: 12 }, (_, i) => ({
            serial: `EC${String(i).padStart(6, '0')}`,
            name: `Space A${i + 1}`,
        }));
        api.observations = new Map(api.chargers.map(c => [c.serial, obs(OP_MODE.disconnected)]));
    }

    it('does nothing with many chargers and no selection, but lists the names', async () => {
        const t = setup();
        carPark(t.api);
        t.service.start();
        await t.clock.next();
        expect(t.service.slots()).to.deep.equal([]);
        expect(t.api.reads).to.deep.equal([]);
        expect(t.objects).to.deep.equal([]);
        expect(t.clock.pending()).to.deep.equal([]);
        const warning = t.logs.find(l => l.level === 'warn')?.message ?? '';
        expect(warning).to.contain('12 chargers');
        expect(warning).to.contain('"Space A7"');
    });

    it('uses only the selected chargers in fixed slots and never switches the others', async () => {
        const t = setup({ ...CONFIG, chargerNames: ['', 'space a8'] });
        carPark(t.api);
        t.service.start();
        await t.clock.next();
        expect(t.service.slots()).to.deep.equal([2]);
        expect(t.api.reads).to.deep.equal(['EC000007']);
        expect(t.states.get('easee.charger2.name')).to.equal('Space A8');
        expect(t.objects.some(id => id.startsWith('easee.charger1'))).to.equal(false);
        await t.service.setCharging(1, true);
        expect(t.api.commands).to.deep.equal([]);
        expect(t.logs.some(l => l.message.includes('other charger(s) ignored'))).to.equal(true);
    });

    it('warns about a name that is not found', async () => {
        const t = setup({ ...CONFIG, chargerNames: ['Space A7', 'Space Z9'] });
        carPark(t.api);
        t.service.start();
        await t.clock.next();
        expect(t.service.slots()).to.deep.equal([1]);
        expect(t.logs.some(l => l.level === 'warn' && l.message.includes('"Space Z9" not found'))).to.equal(true);
    });
});

describe('easee/service with stream', () => {
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- test helper
    async function started() {
        const t = setup({ ...CONFIG, stream: true });
        const stream = new FakeStream();
        stream.connected = true;
        t.service.attachStream(stream);
        t.service.start();
        await t.clock.next();
        return { ...t, stream };
    }

    it('starts the stream with all serials and polls only every 5 min while it is up', async () => {
        const t = await started();
        expect(t.stream.started).to.deep.equal([A, B]);
        expect(t.clock.pending()).to.deep.equal([STREAM_POLL_MS]);
    });

    it('writes pushed values after a short delay, batched', async () => {
        const t = await started();
        t.service.pushObservation(A, { id: OBS.opMode, value: '3', timestamp: '2026-11-05T10:01:00.000Z' });
        t.service.pushObservation(A, { id: OBS.totalPower, value: '11.04', timestamp: '2026-11-05T10:01:00.000Z' });
        t.service.pushObservation('UNKNOWN1', { id: OBS.opMode, value: '3', timestamp: TS });
        expect(t.clock.pending()).to.deep.equal([PUSH_APPLY_DELAY_MS, STREAM_POLL_MS]);
        await t.clock.next();
        expect(t.states.get('easee.charger1.charging')).to.equal(true);
        expect(t.states.get('easee.charger1.power')).to.equal(11.04);
        expect(t.states.get('easee.charger1.lastUpdate')).to.equal(Date.parse('2026-11-05T10:01:00.000Z'));
    });

    it('an older REST answer does not overwrite a newer pushed value', () => {
        const map = new Map<number, RawObservation>();
        merge(map, { id: 109, value: '3', timestamp: '2026-11-05T10:01:00Z' });
        merge(map, { id: 109, value: 6, timestamp: '2026-11-05T10:00:00Z' });
        expect(map.get(109)?.value).to.equal('3');
        merge(map, { id: 109, value: 4, timestamp: '2026-11-05T10:02:00Z' });
        expect(map.get(109)?.value).to.equal(4);
    });

    it('resubscribes 15 s after a command', async () => {
        const t = await started();
        await t.service.setCharging(1, true);
        expect(t.clock.pending()).to.include(RESUBSCRIBE_AFTER_COMMAND_MS);
        while (t.stream.resubscribed.length === 0) {
            await t.clock.next();
        }
        expect(t.stream.resubscribed).to.deep.equal([A]);
    });

    it('falls back to normal polling and reports the stream state', async () => {
        const t = await started();
        t.stream.connected = false;
        t.service.streamConnection(false);
        await Promise.resolve();
        expect(t.states.get('easee.streamConnected')).to.equal(false);
        expect(t.clock.pending()).to.deep.equal([CONFIG.intervalSec * 1000]);
    });

    it('stops the stream on stop', async () => {
        const t = await started();
        t.service.stop();
        expect(t.stream.stopped).to.equal(true);
    });
});
