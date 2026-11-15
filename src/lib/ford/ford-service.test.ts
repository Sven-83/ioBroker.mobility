import { expect } from 'chai';
import type { FordConfig } from './config';
import { FordLoginRequiredError, FordNetworkError } from './errors';
import type { GarageInfo } from './ford-client';
import { EXPIRY_WARNING_MS, FordService, type FordApi, type FordDeps } from './ford-service';

const CONFIG: FordConfig = {
    enabled: true,
    clientId: 'client-placeholder',
    clientSecret: 'secret-placeholder',
    redirectUri: 'http://localhost/fordconnect',
    intervalMin: 10,
    vehicles: [
        { slot: 1, name: 'Car A', tankLitres: 42 },
        { slot: 2, name: 'Car B', tankLitres: 0 },
    ],
};
const MIN = 60_000;

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

class FakeApi implements FordApi {
    public loggedIn = false;
    public codes: string[] = [];
    public telemetryError: Error | undefined;
    public loginError: Error | undefined;
    public reads = 0;
    public garageReads = 0;
    public auth: number | null = null;
    public telemetry: Record<string, unknown> = {
        updateTime: '2026-11-05T10:00:00Z',
        metrics: { xevBatteryStateOfCharge: { value: 80 }, odometer: { value: 1234 } },
    };

    public hasLogin(): Promise<boolean> {
        return Promise.resolve(this.loggedIn);
    }

    public login(code: string): Promise<void> {
        this.codes.push(code);
        if (this.loginError) {
            return Promise.reject(this.loginError);
        }
        this.loggedIn = true;
        return Promise.resolve();
    }

    public forgetLogin(): Promise<void> {
        this.loggedIn = false;
        return Promise.resolve();
    }

    public authTime(): number | null {
        return this.auth;
    }

    public getGarage(): Promise<GarageInfo> {
        this.garageReads++;
        return Promise.resolve({ vehicleType: '2025 Example', engineType: 'BEV', color: 'BLUE' });
    }

    public getTelemetry(): Promise<Record<string, unknown>> {
        this.reads++;
        if (this.telemetryError) {
            return Promise.reject(this.telemetryError);
        }
        return Promise.resolve(this.telemetry);
    }

    public abort(): void {}
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- test helper
function setup() {
    const clock = new FakeClock();
    const apis = new Map<number, FakeApi>([
        [1, new FakeApi()],
        [2, new FakeApi()],
    ]);
    const states = new Map<string, ioBroker.StateValue>();
    const logs: { level: string; message: string }[] = [];
    const connection: boolean[] = [];
    const files = new Map<number, string>();
    const log = (level: string) => (message: string) => logs.push({ level, message });
    const deps: FordDeps = {
        createClient: slot => apis.get(slot)!,
        log: { error: log('error'), warn: log('warn'), info: log('info'), debug: log('debug') },
        now: () => clock.time,
        random: () => 0,
        randomState: () => 'abcdef0123456789ffff',
        setTimeout: (callback, ms) => clock.setTimeout(callback, ms),
        clearTimeout: handle => clock.clearTimeout(handle),
        ensureObjects: () => Promise.resolve(),
        setState: (id, value) => {
            states.set(id, value);
            return Promise.resolve();
        },
        onConnection: connected => connection.push(connected),
        loadHistory: slot => Promise.resolve(files.get(slot)),
        saveHistory: (slot, text) => {
            files.set(slot, text);
            return Promise.resolve();
        },
    };
    return { clock, apis, states, logs, connection, files, service: new FordService(CONFIG, deps) };
}

describe('ford/service', () => {
    it('asks for a login per vehicle and never polls without one', async () => {
        const t = setup();
        await t.service.start();
        const url = new URL(String(t.states.get('ford.vehicle1.login.url')));
        expect(url.searchParams.get('state')).to.equal('abcdef0123456789');
        expect(t.states.get('ford.vehicle2.login.status')).to.contain('Login needed');
        expect(t.clock.pending()).to.deep.equal([]);
        expect(t.logs.filter(l => l.level === 'warn')).to.have.length(2);
    });

    it('takes the pasted address, empties it at once and starts polling', async () => {
        const t = setup();
        await t.service.start();
        await t.service.handleLoginResponse(2, 'http://localhost/fordconnect?code=c1&state=abcdef0123456789');
        expect(t.apis.get(2)?.codes).to.deep.equal(['c1']);
        expect(t.states.get('ford.vehicle2.login.response')).to.equal('');
        expect(t.states.get('ford.vehicle2.login.status')).to.equal('OK');
        expect(t.states.get('ford.vehicle2.login.url')).to.equal('');
        await t.clock.next();
        expect(t.states.get('ford.vehicle2.model')).to.equal('2025 Example');
        expect(t.states.get('ford.vehicle2.soc')).to.equal(80);
        expect(t.states.get('ford.vehicle2.odometer')).to.equal(1234);
        expect(t.clock.pending()).to.deep.equal([10 * MIN]);
    });

    it('refuses an address from an older login link', async () => {
        const t = setup();
        await t.service.start();
        await t.service.handleLoginResponse(1, 'http://localhost/fordconnect?code=c1&state=other');
        expect(t.apis.get(1)?.codes).to.deep.equal([]);
        expect(t.states.get('ford.vehicle1.login.response')).to.equal('');
    });

    it('polls stored logins staggered and reads the garage once a day', async () => {
        const t = setup();
        t.apis.get(1)!.loggedIn = true;
        t.apis.get(2)!.loggedIn = true;
        await t.service.start();
        expect(t.clock.pending()).to.deep.equal([5_000, 25_000]);
        await t.clock.next();
        await t.clock.next();
        await t.clock.next(); // vehicle 1 again after 10 min
        expect(t.apis.get(1)?.garageReads).to.equal(1);
        expect(t.apis.get(1)?.reads).to.equal(2);
        expect(t.connection.at(-1)).to.equal(true);
    });

    it('asks for a new login when the refresh token is rejected', async () => {
        const t = setup();
        t.apis.get(1)!.loggedIn = true;
        await t.service.start();
        t.apis.get(1)!.telemetryError = new FordLoginRequiredError('token refresh: rejected (invalid_grant)');
        await t.clock.next();
        expect(t.apis.get(1)?.loggedIn).to.equal(false);
        expect(t.states.get('ford.vehicle1.login.status')).to.contain('Login needed');
        expect(t.connection.at(-1)).to.equal(false);
    });

    it('backs off on network errors and logs the outage once', async () => {
        const t = setup();
        t.apis.get(1)!.loggedIn = true;
        await t.service.start();
        t.apis.get(1)!.telemetryError = new FordNetworkError('telemetry: no answer (ENOTFOUND)');
        await t.clock.next();
        expect(t.clock.pending()).to.deep.equal([10 * MIN]);
        await t.clock.next();
        expect(t.clock.pending()).to.deep.equal([20 * MIN]);
        expect(t.logs.filter(l => l.level === 'warn' && l.message.includes('ENOTFOUND'))).to.have.length(1);
    });

    it('writes the history states and keeps the history across a restart', async () => {
        const t = setup();
        t.apis.get(1)!.loggedIn = true;
        await t.service.start();
        await t.clock.next();
        expect(JSON.parse(String(t.states.get('ford.vehicle1.history.weeks')))).to.have.length.within(8, 9);
        expect(t.states.get('ford.vehicle1.history.tyreLoss')).to.equal('{}');
        expect(t.states.get('ford.vehicle1.history.fuelConsumption')).to.equal(null);
        expect(t.files.has(1)).to.equal(true);
        expect(JSON.parse(String(t.states.get('ford.vehicle1.warnings')))).to.be.an('array');

        const again = setup();
        again.files.set(1, '{broken');
        again.apis.get(1)!.loggedIn = true;
        await again.service.start();
        expect(again.logs.some(l => l.message.includes('history could not be read'))).to.equal(true);
    });

    it('warns a week before the login expires', async () => {
        const t = setup();
        t.apis.get(1)!.loggedIn = true;
        t.apis.get(1)!.auth = t.clock.time - 365 * 24 * 3_600_000 + EXPIRY_WARNING_MS - MIN;
        await t.service.start();
        await t.clock.next();
        expect(t.logs.some(l => l.message.includes('expires on'))).to.equal(true);
        expect(t.states.has('ford.vehicle1.login.expires')).to.equal(true);
    });

    it('clears values that do not apply and warns about a weak 12 V battery once', async () => {
        const t = setup();
        const api = t.apis.get(1)!;
        api.loggedIn = true;
        api.telemetry = {
            metrics: {
                xevBatteryStateOfCharge: { value: 97 },
                fuelRange: { value: 0 },
                xevPlugChargerStatus: { value: 'DISCONNECTED' },
                xevBatteryTimeToFullCharge: { value: 75 },
                xevBatteryChargerVoltageOutput: { value: 6 },
                xevBatteryChargerCurrentOutput: { value: 0.5 },
                batteryStateOfCharge: { value: 30 },
                doorLockStatus: [{ value: 'LOCKED', vehicleDoor: 'ALL_DOORS' }],
            },
        };
        await t.service.start();
        await t.clock.next();
        expect(t.states.get('ford.vehicle1.fuelRange')).to.equal(null);
        expect(t.states.get('ford.vehicle1.timeToFull')).to.equal(null);
        expect(t.states.get('ford.vehicle1.chargePower')).to.equal(0);
        expect(t.states.get('ford.vehicle1.locked')).to.equal(true);
        expect(t.states.get('ford.vehicle1.battery12vLow')).to.equal(true);
        await t.clock.next();
        expect(t.logs.filter(l => l.message.includes('12 V battery weak'))).to.have.length(1);

        api.telemetry = {
            metrics: {
                batteryStateOfCharge: { value: 80 },
                xevPlugChargerStatus: { value: 'CONNECTED' },
                xevBatteryTimeToFullCharge: { value: 75 },
            },
        };
        await t.clock.next();
        expect(t.states.get('ford.vehicle1.battery12vLow')).to.equal(false);
        expect(t.states.get('ford.vehicle1.timeToFull')).to.equal(75);
        expect(t.logs.some(l => l.message.includes('12 V battery OK again'))).to.equal(true);
    });
});
