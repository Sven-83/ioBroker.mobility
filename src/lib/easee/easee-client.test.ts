import { expect } from 'chai';
import { EaseeClient, TOKEN_MARGIN_MS, isAllowedRequest, type FetchFn } from './easee-client';
import { EaseeAuthError, EaseeNetworkError, EaseeRateLimitedError, EaseeResponseError } from './errors';

// placeholders only - real serials, user names and tokens never go into the repo
const SERIAL = 'EH000000';
const USER = 'user@example.invalid';
const PASSWORD = 'pass word';

interface Call {
    method: string;
    path: string;
    auth: string | undefined;
    body: unknown;
}

type Handler = (call: Call) => { status: number; body?: unknown; headers?: Record<string, string> };

/**
 * @param handler - Answers per call
 * @param calls - Receives the calls
 */
function server(handler: Handler, calls: Call[] = []): FetchFn {
    return (url, init) => {
        const parsed = new URL(url);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const call: Call = {
            method: init?.method ?? 'GET',
            path: parsed.pathname + parsed.search,
            auth: headers.Authorization,
            body: typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : undefined,
        };
        calls.push(call);
        const answer = handler(call);
        const text = answer.body === undefined ? '' : JSON.stringify(answer.body);
        return Promise.resolve(new Response(text, { status: answer.status, headers: answer.headers }));
    };
}

/**
 * @param n - Token number
 * @param expiresIn - Lifetime in s
 */
function token(n: number, expiresIn = 3600): { status: number; body: unknown } {
    return {
        status: 200,
        body: { accessToken: `access${n}`, refreshToken: `refresh${n}`, expiresIn, tokenType: 'Bearer' },
    };
}

/**
 * @param promise - Promise that must reject
 */
async function rejection(promise: Promise<unknown>): Promise<Error> {
    try {
        await promise;
    } catch (error) {
        return error as Error;
    }
    throw new Error('expected a rejection');
}

describe('easee/client', () => {
    it('logs in once and lists chargers sorted by serial', async () => {
        const calls: Call[] = [];
        const client = new EaseeClient(USER, PASSWORD, {
            fetch: server(call => {
                if (call.path === '/api/accounts/login') {
                    return token(1);
                }
                return {
                    status: 200,
                    body: [
                        { id: 'ES000000', name: ' Garage ' },
                        { id: 'eh000000', name: 'Carport' },
                        { id: 'bad id!', name: 'x' },
                    ],
                };
            }, calls),
        });
        const chargers = await client.getChargers();
        expect(chargers).to.deep.equal([
            { serial: 'EH000000', name: 'Carport' },
            { serial: 'ES000000', name: 'Garage' },
        ]);
        await client.getChargers();
        expect(calls.filter(c => c.path === '/api/accounts/login')).to.have.length(1);
        expect(calls[0].body).to.deep.equal({ userName: USER, password: PASSWORD });
        expect(calls[0].auth).to.equal(undefined);
        expect(calls[1].auth).to.equal('Bearer access1');
    });

    it('reads observations with comma-separated ids', async () => {
        const calls: Call[] = [];
        const client = new EaseeClient(USER, PASSWORD, {
            fetch: server(call => {
                if (call.path === '/api/accounts/login') {
                    return token(1);
                }
                return {
                    status: 200,
                    body: {
                        observations: [
                            { id: 109, value: 3, timestamp: '2026-11-05T10:00:00Z', dataType: 4 },
                            { id: 'x', value: 1 },
                        ],
                    },
                };
            }, calls),
        });
        const observations = await client.getObservations(SERIAL, [109, 120]);
        expect(observations).to.deep.equal([{ id: 109, value: 3, timestamp: '2026-11-05T10:00:00Z' }]);
        expect(calls[1].path).to.equal(`/state/${SERIAL}/observations?ids=109%2C120`);
    });

    it('refreshes the token before it expires and keeps the old refresh token if none comes back', async () => {
        let time = 0;
        const calls: Call[] = [];
        let refreshes = 0;
        const client = new EaseeClient(USER, PASSWORD, {
            now: () => time,
            fetch: server(call => {
                if (call.path === '/api/accounts/login') {
                    return token(1);
                }
                if (call.path === '/api/accounts/refresh_token') {
                    refreshes++;
                    return { status: 200, body: { accessToken: `access-r${refreshes}`, expiresIn: 3600 } };
                }
                return { status: 200, body: [] };
            }, calls),
        });
        await client.getChargers();
        time = 3600_000 - TOKEN_MARGIN_MS + 1;
        await client.getChargers();
        const refresh = calls.find(c => c.path === '/api/accounts/refresh_token');
        expect(refresh?.body).to.deep.equal({ refreshToken: 'refresh1' });
        expect(refresh?.auth).to.equal('Bearer access1');
        time += 3600_000;
        await client.getChargers();
        const second = calls.filter(c => c.path === '/api/accounts/refresh_token')[1];
        expect(second.body).to.deep.equal({ refreshToken: 'refresh1' });
        expect(calls.at(-1)?.auth).to.equal('Bearer access-r2');
    });

    it('falls back to a fresh login when the refresh token is rejected', async () => {
        let time = 0;
        let logins = 0;
        const client = new EaseeClient(USER, PASSWORD, {
            now: () => time,
            fetch: server(call => {
                if (call.path === '/api/accounts/login') {
                    logins++;
                    return token(logins);
                }
                if (call.path === '/api/accounts/refresh_token') {
                    return { status: 400, body: { title: 'invalid' } };
                }
                return { status: 200, body: [] };
            }),
        });
        await client.getChargers();
        time = 3600_000;
        await client.getChargers();
        expect(logins).to.equal(2);
    });

    it('gets a new token after HTTP 401 and retries once', async () => {
        let logins = 0;
        let listCalls = 0;
        const client = new EaseeClient(USER, PASSWORD, {
            fetch: server(call => {
                if (call.path === '/api/accounts/login') {
                    logins++;
                    return token(logins);
                }
                if (call.path === '/api/accounts/refresh_token') {
                    return { status: 401 };
                }
                listCalls++;
                return call.auth === 'Bearer access1' ? { status: 401 } : { status: 200, body: [] };
            }),
        });
        expect(await client.getChargers()).to.deep.equal([]);
        expect(listCalls).to.equal(2);
        expect(logins).to.equal(2);
    });

    it('maps a rejected login to EaseeAuthError without the password', async () => {
        const client = new EaseeClient(USER, PASSWORD, {
            fetch: server(() => ({ status: 400, body: { title: 'Invalid username or password' } })),
        });
        const error = await rejection(client.getChargers());
        expect(error).to.be.instanceOf(EaseeAuthError);
        expect(error.message).not.to.contain(PASSWORD);
        expect(error.message).not.to.contain(USER);
    });

    it('maps 429 with Retry-After to EaseeRateLimitedError', async () => {
        const client = new EaseeClient(USER, PASSWORD, {
            fetch: server(call =>
                call.path === '/api/accounts/login' ? token(1) : { status: 429, headers: { 'retry-after': '90' } },
            ),
        });
        const error = await rejection(client.getObservations(SERIAL));
        expect(error).to.be.instanceOf(EaseeRateLimitedError);
        expect((error as EaseeRateLimitedError).waitMs).to.equal(90_000);
    });

    it('never puts serial, token or URL into error messages', async () => {
        const failing: FetchFn = url =>
            Promise.reject(Object.assign(new TypeError(`fetch failed for ${url}`), { cause: { code: 'ECONNRESET' } }));
        const network = await rejection(new EaseeClient(USER, PASSWORD, { fetch: failing }).getObservations(SERIAL));
        expect(network).to.be.instanceOf(EaseeNetworkError);
        expect(network.message).to.contain('ECONNRESET');

        const client = new EaseeClient(USER, PASSWORD, {
            fetch: server(call => (call.path === '/api/accounts/login' ? token(1) : { status: 500 })),
        });
        const error = await rejection(client.command(SERIAL, 'pause_charging'));
        expect(error).to.be.instanceOf(EaseeResponseError);
        for (const secret of [SERIAL, 'access1', 'http', PASSWORD]) {
            expect(error.message).not.to.contain(secret);
            expect(network.message).not.to.contain(secret);
        }
    });

    it('sends commands as POST and accepts an empty answer', async () => {
        const calls: Call[] = [];
        const client = new EaseeClient(USER, PASSWORD, {
            fetch: server(call => (call.path === '/api/accounts/login' ? token(1) : { status: 202 }), calls),
        });
        await client.command(SERIAL, 'resume_charging');
        expect(calls[1]).to.include({ method: 'POST', path: `/api/chargers/${SERIAL}/commands/resume_charging` });
    });

    it('allows only reading, login and the four charging commands - never deleting or changing', () => {
        expect(isAllowedRequest('POST', '/api/accounts/login')).to.equal(true);
        expect(isAllowedRequest('GET', '/api/chargers')).to.equal(true);
        expect(isAllowedRequest('GET', `/state/${SERIAL}/observations?ids=109%2C120`)).to.equal(true);
        expect(isAllowedRequest('POST', `/api/chargers/${SERIAL}/commands/stop_charging`)).to.equal(true);
        expect(isAllowedRequest('DELETE', `/api/chargers/${SERIAL}`)).to.equal(false);
        expect(isAllowedRequest('DELETE', '/api/sites/1')).to.equal(false);
        expect(isAllowedRequest('POST', `/api/chargers/${SERIAL}/settings`)).to.equal(false);
        expect(isAllowedRequest('POST', `/api/chargers/${SERIAL}/commands/reboot`)).to.equal(false);
        expect(isAllowedRequest('PUT', '/api/chargers')).to.equal(false);
        expect(isAllowedRequest('GET', '/api/chargers/../sites')).to.equal(false);
        expect(
            isAllowedRequest(
                'GET',
                `/api/sessions/charger/${SERIAL}/sessions/2025-11-14T08:00:00Z/2026-11-14T08:00:00Z`,
            ),
        ).to.equal(true);
        expect(isAllowedRequest('GET', `/api/sessions/charger/${SERIAL}/sessions/x/y`)).to.equal(false);
        expect(isAllowedRequest('DELETE', `/api/sessions/charger/${SERIAL}/sessions/x/y`)).to.equal(false);
        expect(isAllowedRequest('GET', `/api/chargers/${SERIAL}/sessions/latest`)).to.equal(false);
    });

    it('rejects invalid serials before any request', async () => {
        const calls: Call[] = [];
        const client = new EaseeClient(USER, PASSWORD, { fetch: server(() => token(1), calls) });
        expect(await rejection(client.command('../accounts', 'stop_charging'))).to.be.instanceOf(EaseeResponseError);
        expect(calls).to.have.length(0);
    });
});
