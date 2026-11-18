import { expect } from 'chai';
import { FordClientRejectedError, FordLoginRequiredError, FordRateLimitedError, FordResponseError } from './errors';
import {
    FordClient,
    INTERNAL_ERROR_RETRIES,
    TOKEN_MARGIN_MS,
    authTimeFromIdToken,
    b2cErrorCode,
    buildAuthorizeUrl,
    parseRedirect,
    type FetchFn,
    type FordToken,
    type TokenStore,
} from './ford-client';
import { battery12vLow, isBev, parseTelemetry, sanitize } from './telemetry';
import { readFordConfig, DEFAULT_REDIRECT_URI, MIN_INTERVAL_MIN } from './config';
import { parseVehicleCommandId } from './objects';
import { sharedAccessHint } from './ford-service';

// placeholders only - real client IDs, secrets, tokens and VINs never go into the repo
const CLIENT = 'client-placeholder';
const SECRET = 'secret-placeholder';
const REDIRECT = 'http://localhost/fordconnect';

interface Call {
    method: string;
    url: URL;
    auth: string | undefined;
    form: URLSearchParams | undefined;
}

/**
 * @param handler - Answer per call
 * @param calls - Receives the calls
 */
function server(
    handler: (call: Call) => { status: number; body?: unknown; headers?: Record<string, string> },
    calls: Call[] = [],
): FetchFn {
    return (url, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const call: Call = {
            method: init?.method ?? 'GET',
            url: new URL(url),
            auth: headers.Authorization,
            form: typeof init?.body === 'string' ? new URLSearchParams(init.body) : undefined,
        };
        calls.push(call);
        const answer = handler(call);
        const text = answer.body === undefined ? '' : JSON.stringify(answer.body);
        return Promise.resolve(new Response(text, { status: answer.status, headers: answer.headers }));
    };
}

/** In-memory token store */
class MemoryStore implements TokenStore {
    public token: FordToken | undefined;
    public saves = 0;

    public load(): Promise<FordToken | undefined> {
        return Promise.resolve(this.token);
    }

    public save(token: FordToken | undefined): Promise<void> {
        this.saves++;
        this.token = token;
        return Promise.resolve();
    }
}

/**
 * @param authTime - auth_time in seconds
 */
function idToken(authTime: number): string {
    // built at runtime: no token-like literal in the repo
    return ['h', Buffer.from(JSON.stringify({ auth_time: authTime })).toString('base64url'), 's'].join('.');
}

/**
 * @param promise - Must reject
 */
async function rejection(promise: Promise<unknown>): Promise<Error> {
    try {
        await promise;
    } catch (error) {
        return error as Error;
    }
    throw new Error('expected a rejection');
}

describe('ford/client', () => {
    it('builds the login URL with a state of at most 16 characters', () => {
        const url = new URL(buildAuthorizeUrl(CLIENT, REDIRECT, '0123456789abcdefXYZ'));
        expect(url.origin + url.pathname).to.equal('https://api.vehicle.ford.com/fcon-public/v1/auth/init');
        expect(url.searchParams.get('response_type')).to.equal('code');
        expect(url.searchParams.get('client_id')).to.equal(CLIENT);
        expect(url.searchParams.get('redirect_uri')).to.equal(REDIRECT);
        expect(url.searchParams.get('state')).to.equal('0123456789abcdef');
    });

    it('parses the pasted address, a query or a bare code', () => {
        expect(parseRedirect(' http://localhost/fordconnect?code=abc&state=s1 ')).to.deep.equal({
            code: 'abc',
            state: 's1',
            error: null,
        });
        expect(parseRedirect('code=abc')).to.deep.equal({ code: 'abc', state: null, error: null });
        expect(parseRedirect('abc')).to.deep.equal({ code: 'abc', state: null, error: null });
        expect(parseRedirect('http://localhost/fordconnect?error=access_denied').error).to.equal('access_denied');
    });

    it('reads auth_time from an id_token', () => {
        expect(authTimeFromIdToken(idToken(1_700_000_000))).to.equal(1_700_000_000_000);
        expect(authTimeFromIdToken('broken')).to.equal(null);
        expect(authTimeFromIdToken(undefined)).to.equal(null);
    });

    it('logs in with the code, stores the token and reads garage and telemetry', async () => {
        const calls: Call[] = [];
        const store = new MemoryStore();
        const client = new FordClient(CLIENT, SECRET, REDIRECT, store, {
            now: () => 1_000,
            fetch: server(call => {
                if (call.method === 'POST') {
                    return {
                        status: 200,
                        body: { access_token: 'a1', refresh_token: 'r1', expires_in: 1200, id_token: idToken(5) },
                    };
                }
                if (call.url.pathname.endsWith('/garage')) {
                    return { status: 200, body: { vehicleType: '2025 Example', engineType: 'BEV', color: 'BLUE' } };
                }
                return { status: 200, body: { updateTime: '2026-11-05T10:00:00Z', metrics: {} } };
            }, calls),
        });
        expect(await client.hasLogin()).to.equal(false);
        await client.login('the-code');
        expect(store.token).to.deep.include({ access: 'a1', refresh: 'r1', expiresAt: 1_201_000, authTime: 5000 });
        const form = calls[0].form;
        expect(calls[0].url.pathname).to.equal('/dah2vb2cprod.onmicrosoft.com/oauth2/v2.0/token');
        expect(calls[0].url.searchParams.get('p')).to.equal('B2C_1A_FCON_AUTHORIZE');
        expect(form?.get('grant_type')).to.equal('authorization_code');
        expect(form?.get('code')).to.equal('the-code');
        expect(form?.get('redirect_uri')).to.equal(REDIRECT);
        expect(form?.get('client_id')).to.equal(CLIENT);

        expect(await client.getGarage()).to.deep.equal({
            vehicleType: '2025 Example',
            engineType: 'BEV',
            color: 'BLUE',
        });
        await client.getTelemetry();
        expect(calls[1].url.pathname).to.equal('/fcon-query/v1/garage');
        expect(calls[2].url.pathname).to.equal('/fcon-query/v1/telemetry');
        expect(calls[2].auth).to.equal('Bearer a1');
    });

    it('refreshes before expiry and keeps refresh token and auth time when they are missing', async () => {
        let time = 0;
        const store = new MemoryStore();
        store.token = { access: 'a1', refresh: 'r1', expiresAt: 1_200_000, authTime: 77 };
        const calls: Call[] = [];
        const client = new FordClient(CLIENT, SECRET, REDIRECT, store, {
            now: () => time,
            fetch: server(
                call =>
                    call.method === 'POST'
                        ? { status: 200, body: { access_token: 'a2', expires_in: 1200 } }
                        : { status: 200, body: { metrics: {} } },
                calls,
            ),
        });
        time = 1_200_000 - TOKEN_MARGIN_MS + 1;
        await client.getTelemetry();
        expect(calls[0].form?.get('grant_type')).to.equal('refresh_token');
        expect(calls[0].form?.get('refresh_token')).to.equal('r1');
        expect(store.token).to.deep.include({ access: 'a2', refresh: 'r1', authTime: 77 });
        expect(calls[1].auth).to.equal('Bearer a2');
    });

    it('needs a new login without token or when the refresh token is rejected', async () => {
        const empty = new FordClient(CLIENT, SECRET, REDIRECT, new MemoryStore(), {
            fetch: server(() => ({ status: 200 })),
        });
        expect(await rejection(empty.getTelemetry())).to.be.instanceOf(FordLoginRequiredError);

        const store = new MemoryStore();
        store.token = { access: 'a1', refresh: 'r1', expiresAt: 0, authTime: null };
        const client = new FordClient(CLIENT, SECRET, REDIRECT, store, {
            fetch: server(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'secret stuff' } })),
        });
        const error = await rejection(client.getTelemetry());
        expect(error).to.be.instanceOf(FordLoginRequiredError);
        expect(error.message).to.contain('invalid_grant');
        expect(error.message).not.to.contain('secret stuff');
    });

    it('names the Azure AD B2C error code, but no other error text', async () => {
        expect(b2cErrorCode('AADB2C90085: The service has encountered an internal error.')).to.equal('AADB2C90085');
        expect(b2cErrorCode('invalid_grant')).to.equal(null);
        expect(b2cErrorCode(null)).to.equal(null);
        expect(
            parseRedirect('http://localhost/fordconnect?error=server_error&error_description=AADB2C90085%3a+x').error,
        ).to.contain('AADB2C90085');
        expect(sharedAccessHint('AADB2C90085')).to.contain('main FordPass account');
        expect(sharedAccessHint('AADB2C90000')).to.equal('');
        expect(sharedAccessHint(null)).to.equal('');

        const store = new MemoryStore();
        store.token = { access: 'a1', refresh: 'r1', expiresAt: 0, authTime: null };
        const client = new FordClient(CLIENT, SECRET, REDIRECT, store, {
            fetch: server(() => ({
                status: 400,
                body: { error: 'invalid_grant', error_description: 'AADB2C90085: secret stuff' },
            })),
        });
        // Ford's "internal error": keep the login and try again, a new login only after several in a row
        for (let i = 0; i < INTERNAL_ERROR_RETRIES; i++) {
            const retry = await rejection(client.getTelemetry());
            expect(retry).to.be.instanceOf(FordResponseError);
            expect(retry.message).to.contain('AADB2C90085');
            expect(retry.message).not.to.contain('secret stuff');
            expect(store.token?.refresh).to.equal('r1');
        }
        const error = await rejection(client.getTelemetry());
        expect(error).to.be.instanceOf(FordLoginRequiredError);
        expect(error.message).to.contain('invalid_grant, AADB2C90085');
        expect(error.message).not.to.contain('secret stuff');
    });

    it('starts counting the internal Ford error again after a working refresh', async () => {
        const store = new MemoryStore();
        store.token = { access: 'a1', refresh: 'r1', expiresAt: 0, authTime: null };
        let fail = true;
        const client = new FordClient(CLIENT, SECRET, REDIRECT, store, {
            now: () => 0,
            fetch: server(call => {
                if (call.method !== 'POST') {
                    return { status: 200, body: { metrics: {} } };
                }
                return fail
                    ? { status: 400, body: { error: 'invalid_grant', error_description: 'AADB2C90085: x' } }
                    : { status: 200, body: { access_token: 'a2', expires_in: 0.001 } };
            }),
        });
        for (let i = 0; i < INTERNAL_ERROR_RETRIES; i++) {
            expect(await rejection(client.getTelemetry())).to.be.instanceOf(FordResponseError);
        }
        fail = false;
        await client.getTelemetry();
        fail = true;
        expect(await rejection(client.getTelemetry())).to.be.instanceOf(FordResponseError);
    });

    it('reports a rejected client, 429 and never leaks secrets', async () => {
        const rejected = new FordClient(CLIENT, SECRET, REDIRECT, new MemoryStore(), {
            fetch: server(() => ({ status: 401, body: { error: 'invalid_client' } })),
        });
        const error = await rejection(rejected.login('the-code'));
        expect(error).to.be.instanceOf(FordClientRejectedError);
        for (const secret of [SECRET, 'the-code', CLIENT, 'http']) {
            expect(error.message).not.to.contain(secret);
        }

        const store = new MemoryStore();
        store.token = { access: 'a1', refresh: 'r1', expiresAt: Number.MAX_SAFE_INTEGER, authTime: null };
        const limited = new FordClient(CLIENT, SECRET, REDIRECT, store, {
            fetch: server(() => ({ status: 429, headers: { 'retry-after': '120' } })),
        });
        const limit = await rejection(limited.getTelemetry());
        expect(limit).to.be.instanceOf(FordRateLimitedError);
        expect((limit as FordRateLimitedError).waitMs).to.equal(120_000);
    });
});

describe('ford/telemetry', () => {
    const body = {
        updateTime: '2026-11-05T10:00:00Z',
        vin: 'WF0XXXXXXXXXXXXXX',
        metrics: {
            fuelLevel: { value: 61.5, updateTime: '2026-11-05T09:59:00Z' },
            odometer: { value: '12345.6' },
            xevBatteryStateOfCharge: { value: 80 },
            xevPlugChargerStatus: { value: 'CONNECTED' },
            ignitionStatus: { value: 'OFF' },
            position: { value: { location: { lat: 1, lon: 2 } } },
            tirePressure: [
                { value: 240, vehicleWheel: 'FRONT_LEFT' },
                { value: 238.5, vehicleWheel: 'REAR_RIGHT' },
                { value: 1, vehicleWheel: { x: 1 } },
            ],
            doorStatus: [
                { value: 'CLOSED', vehicleDoor: 'UNSPECIFIED_FRONT' },
                { value: 'CLOSED', vehicleDoor: 'REAR_LEFT' },
            ],
        },
    };

    it('maps the known metrics', () => {
        const st = parseTelemetry(body);
        expect(st.updateTime).to.equal(Date.parse('2026-11-05T10:00:00Z'));
        expect(st.fuelLevel).to.equal(61.5);
        expect(st.odometer).to.equal(12345.6);
        expect(st.soc).to.equal(80);
        expect(st.plugStatus).to.equal('CONNECTED');
        expect(st.fuelRange).to.equal(null);
        expect(st.tires).to.deep.equal({ frontLeft: 240, rearRight: 238.5 });
        expect(st.doorsClosed).to.equal(true);
        expect(st.metricKeys).to.include('position');
    });

    it('removes VIN and position from the stored copy', () => {
        const clean = JSON.stringify(sanitize(body));
        expect(clean).not.to.contain('WF0');
        expect(clean).not.to.contain('position');
        expect(clean).not.to.contain('lat');
        expect(clean).to.contain('fuelLevel');
        expect(sanitize({ note: 'car WF0XXXXXXXXXXXXXX here' })).to.deep.equal({ note: 'car <vin> here' });
    });

    it('removes the Ford vehicle ID but keeps vehicleWheel/vehicleDoor', () => {
        const clean = sanitize({
            vehicleId: 'id-placeholder',
            metrics: { tirePressure: [{ value: 240, vehicleWheel: 'FRONT_LEFT' }] },
        }) as Record<string, unknown>;
        expect(clean).not.to.have.property('vehicleId');
        expect(JSON.stringify(clean)).to.contain('vehicleWheel');
    });

    // shapes as delivered by a battery electric vehicle (values made up)
    const bev = {
        updateTime: '2026-11-05T10:00:00Z',
        metrics: {
            xevBatteryStateOfCharge: { value: 97 },
            xevBatteryActualStateOfCharge: { value: 80.33 },
            xevBatteryRange: { value: 269.2 },
            xevBatteryMaximumRange: { value: 296.9 },
            xevBatteryEnergyRemaining: { value: 38 },
            xevBatteryCapacity: { value: 49.4 },
            xevBatteryTemperature: { value: 7.5 },
            xevBatteryChargerVoltageOutput: { value: 360 },
            xevBatteryChargerCurrentOutput: { value: 30.5 },
            xevPlugChargerStatus: { value: 'CONNECTED' },
            fuelRange: { value: 0 },
            batteryStateOfCharge: { value: 86 },
            doorLockStatus: [
                { value: 'UNLOCKED', vehicleDoor: 'ALL_DOORS' },
                { value: 'LOCKED', vehicleDoor: 'UNSPECIFIED_FRONT' },
            ],
            windowStatus: [
                { value: { doubleRange: { lowerBound: 0, upperBound: 0 } } },
                { value: { doubleRange: { lowerBound: 0, upperBound: 10 } } },
            ],
        },
    };

    it('maps battery, charging, lock and window values', () => {
        const st = parseTelemetry(bev);
        expect(st.soc).to.equal(97);
        expect(st.evMaxRange).to.equal(296.9);
        expect(st.energyRemaining).to.equal(38);
        expect(st.batteryCapacity).to.equal(49.4);
        expect(st.batteryTemp).to.equal(7.5);
        expect(st.chargePower).to.equal(10.98);
        expect(st.locked).to.equal(false);
        expect(st.windowsClosed).to.equal(false);
        expect(isBev(st)).to.equal(true);
        expect(isBev(parseTelemetry(body))).to.equal(false);

        const closed = parseTelemetry({
            metrics: {
                doorLockStatus: [{ value: 'LOCKED', vehicleDoor: 'ALL_DOORS' }],
                windowStatus: [{ value: { doubleRange: { lowerBound: 0, upperBound: 0 } } }],
            },
        });
        expect(closed.locked).to.equal(true);
        expect(closed.windowsClosed).to.equal(true);
        // not delivered = unknown
        expect(parseTelemetry(body).locked).to.equal(null);
        expect(parseTelemetry(body).windowsClosed).to.equal(null);
    });

    it('rates the 12 V battery by charge, else by resting voltage', () => {
        const rate = (metrics: Record<string, unknown>): boolean | null => battery12vLow(parseTelemetry({ metrics }));
        expect(rate({ batteryStateOfCharge: { value: 30 } })).to.equal(true);
        expect(rate({ batteryStateOfCharge: { value: 86 } })).to.equal(false);
        expect(rate({ batteryVoltage: { value: 12.1 }, ignitionStatus: { value: 'OFF' } })).to.equal(true);
        // engine running: voltage says nothing about the battery
        expect(rate({ batteryVoltage: { value: 12.1 }, ignitionStatus: { value: 'RUN' } })).to.equal(null);
        expect(rate({})).to.equal(null);
    });
});

describe('ford/config', () => {
    it('needs switch, client ID, secret and at least one vehicle', () => {
        const ok = readFordConfig({
            fordEnabled: true,
            fordClientId: ` ${CLIENT} `,
            fordClientSecret: SECRET,
            fordVehicle2Name: 'Car B',
        });
        expect(ok.config.enabled).to.equal(true);
        expect(ok.config.vehicles).to.deep.equal([{ slot: 2, name: 'Car B', tankLitres: 0 }]);
        expect(ok.config.redirectUri).to.equal(DEFAULT_REDIRECT_URI);
        const missing = readFordConfig({ fordEnabled: true, fordClientId: CLIENT, fordClientSecret: SECRET });
        expect(missing.config.enabled).to.equal(false);
        expect(missing.problems.join()).not.to.contain(SECRET);
    });

    it('validates redirect URI and interval', () => {
        const { config, problems } = readFordConfig({ fordRedirectUri: 'javascript:alert(1)', fordInterval: 1 });
        expect(config.redirectUri).to.equal(DEFAULT_REDIRECT_URI);
        expect(problems).to.have.length(1);
        expect(config.intervalMin).to.equal(MIN_INTERVAL_MIN);
    });

    it('parses command IDs', () => {
        expect(parseVehicleCommandId('mobility.0', 'mobility.0.ford.vehicle2.login.response')).to.deep.equal({
            slot: 2,
            command: 'login',
        });
        expect(parseVehicleCommandId('mobility.0', 'mobility.0.ford.vehicle1.refresh')?.command).to.equal('refresh');
        expect(parseVehicleCommandId('mobility.0', 'mobility.0.ford.vehicle1.login.token')).to.equal(undefined);
    });
});
