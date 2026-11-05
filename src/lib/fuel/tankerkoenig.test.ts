import { expect } from 'chai';
import {
    FuelAbortedError,
    FuelKeyRejectedError,
    FuelNetworkError,
    FuelRateLimitedError,
    FuelRefusedError,
    FuelResponseError,
} from './errors';
import {
    DEFAULT_RATE_LIMIT_WAIT_MS,
    TankerkoenigClient,
    normalizeApiKey,
    parsePrice,
    parseRetryAfter,
    type FetchFn,
} from './tankerkoenig';

// placeholders only - real keys and station IDs never go into the repo
const KEY = '00000000-0000-0000-0000-00000000000a';
const S1 = '00000000-0000-0000-0000-000000000001';
const S2 = '00000000-0000-0000-0000-000000000002';
const S3 = '00000000-0000-0000-0000-000000000003';

/**
 * @param status - HTTP status
 * @param body - Body (objects become JSON)
 * @param calls - Receives the requested URLs
 * @param headers - Response headers
 */
function answer(status: number, body: unknown, calls: string[] = [], headers: Record<string, string> = {}): FetchFn {
    return url => {
        calls.push(url);
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        return Promise.resolve(new Response(text, { status, headers }));
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

describe('fuel/tankerkoenig', () => {
    describe('getPrices', () => {
        it('parses open, closed and missing prices and sends ids + key', async () => {
            const calls: string[] = [];
            const client = new TankerkoenigClient(KEY, {
                fetch: answer(
                    200,
                    {
                        ok: true,
                        license: 'CC BY 4.0',
                        data: 'MTS-K',
                        prices: {
                            [S1]: { status: 'open', e5: 1.789, e10: 1.729, diesel: 1.659 },
                            [S2]: { status: 'open', e5: 1.799, e10: false, diesel: 1.669 },
                            [S3]: { status: 'closed' },
                        },
                    },
                    calls,
                ),
            });
            const prices = await client.getPrices([S1, S2.toUpperCase(), S3]);
            expect(prices.get(S1)).to.deep.equal({ status: 'open', e10: 1.729 });
            expect(prices.get(S2)?.e10).to.equal(null);
            expect(prices.get(S3)).to.deep.equal({ status: 'closed', e10: null });

            const url = new URL(calls[0]);
            expect(url.pathname).to.equal('/json/prices.php');
            expect(url.searchParams.get('ids')).to.equal(`${S1},${S2},${S3}`);
            expect(url.searchParams.get('apikey')).to.equal(KEY);
        });

        it('rejects invalid station IDs before any request', async () => {
            const calls: string[] = [];
            const client = new TankerkoenigClient(KEY, { fetch: answer(200, {}, calls) });
            const error = await rejection(client.getPrices(['abc&apikey=x']));
            expect(error).to.be.instanceOf(FuelResponseError);
            expect(calls).to.have.length(0);
        });

        it('rejects more than 10 stations', async () => {
            const client = new TankerkoenigClient(KEY, { fetch: answer(200, {}) });
            const ids = Array.from(
                { length: 11 },
                (_, i) => `00000000-0000-0000-0000-0000000000${String(i).padStart(2, '0')}`,
            );
            expect(await rejection(client.getPrices(ids))).to.be.instanceOf(FuelResponseError);
        });

        it('maps ok:false with an apikey message to FuelKeyRejectedError', async () => {
            const client = new TankerkoenigClient(KEY, {
                fetch: answer(200, { ok: false, message: 'apikey nicht angegeben, falsch, oder im falschen Format' }),
            });
            expect(await rejection(client.getPrices([S1]))).to.be.instanceOf(FuelKeyRejectedError);
        });

        it('maps the real "unknown key" answer to FuelKeyRejectedError', async () => {
            // recorded 2026-11-05 with a made-up key
            const client = new TankerkoenigClient(KEY, {
                fetch: answer(200, { status: 'error', ok: false, message: 'Key existiert nicht oder ist deaktiviert' }),
            });
            expect(await rejection(client.getPrices([S1]))).to.be.instanceOf(FuelKeyRejectedError);
        });

        it('ignores entries with invalid IDs (demo key answers "xxx": no stations)', async () => {
            // recorded 2026-11-05 with the public demo key
            const client = new TankerkoenigClient(KEY, {
                fetch: answer(200, { ok: true, prices: { xxx: { status: 'no stations' } } }),
            });
            expect((await client.getPrices([S1])).size).to.equal(0);
        });

        it('maps other ok:false answers to FuelRefusedError (terms: no further requests)', async () => {
            const client = new TankerkoenigClient(KEY, {
                fetch: answer(200, { ok: false, message: 'Wartungsarbeiten' }),
            });
            const error = await rejection(client.getPrices([S1]));
            expect(error).to.be.instanceOf(FuelRefusedError);
            expect(error.message).to.contain('Wartungsarbeiten');
        });

        it('maps HTTP 401 to FuelKeyRejectedError', async () => {
            const client = new TankerkoenigClient(KEY, { fetch: answer(401, { ok: false }) });
            expect(await rejection(client.getPrices([S1]))).to.be.instanceOf(FuelKeyRejectedError);
        });

        it('maps HTTP 429 with Retry-After to FuelRateLimitedError', async () => {
            const client = new TankerkoenigClient(KEY, { fetch: answer(429, '', [], { 'retry-after': '120' }) });
            const error = await rejection(client.getPrices([S1]));
            expect(error).to.be.instanceOf(FuelRateLimitedError);
            expect((error as FuelRateLimitedError).waitMs).to.equal(120_000);
        });

        it('uses the default wait after a 429 without Retry-After', async () => {
            const client = new TankerkoenigClient(KEY, { fetch: answer(429, '') });
            const error = (await rejection(client.getPrices([S1]))) as FuelRateLimitedError;
            expect(error.waitMs).to.equal(DEFAULT_RATE_LIMIT_WAIT_MS);
        });

        it('maps non-JSON and HTTP errors to FuelResponseError', async () => {
            const html = new TankerkoenigClient(KEY, { fetch: answer(503, '<html>maintenance</html>') });
            const error = await rejection(html.getPrices([S1]));
            expect(error).to.be.instanceOf(FuelResponseError);
            expect((error as FuelResponseError).status).to.equal(503);
            const noPrices = new TankerkoenigClient(KEY, { fetch: answer(200, { ok: true }) });
            expect(await rejection(noPrices.getPrices([S1]))).to.be.instanceOf(FuelResponseError);
        });

        it('never puts the key or the URL into error messages', async () => {
            const failing: FetchFn = url =>
                Promise.reject(
                    Object.assign(new TypeError(`fetch failed for ${url}`), { cause: { code: 'ENOTFOUND' } }),
                );
            const client = new TankerkoenigClient(KEY, { fetch: failing });
            const error = await rejection(client.getPrices([S1]));
            expect(error).to.be.instanceOf(FuelNetworkError);
            expect(error.message).to.contain('ENOTFOUND');
            expect(error.message).not.to.contain(KEY);
            expect(error.message).not.to.contain('http');

            const rejected = new TankerkoenigClient(KEY, {
                fetch: answer(200, { ok: false, message: 'apikey falsch' }),
            });
            expect((await rejection(rejected.getPrices([S1]))).message).not.to.contain(KEY);
        });

        it('reports an abort as FuelAbortedError', async () => {
            const hanging: FetchFn = (_url, init) =>
                new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
                });
            const client = new TankerkoenigClient(KEY, { fetch: hanging });
            const pending = rejection(client.getPrices([S1]));
            client.abort();
            expect(await pending).to.be.instanceOf(FuelAbortedError);
        });
    });

    describe('getDetail', () => {
        it('reads the master data', async () => {
            const client = new TankerkoenigClient(KEY, {
                fetch: answer(200, {
                    ok: true,
                    station: {
                        id: S1,
                        name: ' Beispiel Tankstelle ',
                        brand: 'BEISPIEL',
                        street: 'Musterstraße',
                        houseNumber: '1',
                        postCode: 12345,
                        place: 'Musterstadt',
                        isOpen: true,
                        wholeDay: false,
                    },
                }),
            });
            const detail = await client.getDetail(S1);
            expect(detail.name).to.equal('Beispiel Tankstelle');
            expect(detail.brand).to.equal('BEISPIEL');
            expect(detail.postCode).to.equal(''); // numbers are not accepted as text
            expect(detail.isOpen).to.equal(true);
        });
    });

    describe('helpers', () => {
        it('normalizeApiKey removes whitespace and lowercases', () => {
            expect(normalizeApiKey(` ${KEY.toUpperCase()}\n`)).to.equal(KEY);
            expect(normalizeApiKey(undefined)).to.equal('');
        });

        it('parsePrice accepts plausible numbers only', () => {
            expect(parsePrice(1.7289)).to.equal(1.729);
            expect(parsePrice(false)).to.equal(null);
            expect(parsePrice(0)).to.equal(null);
            expect(parsePrice(99)).to.equal(null);
            expect(parsePrice('1.7')).to.equal(null);
        });

        it('parseRetryAfter handles seconds, dates and garbage', () => {
            expect(parseRetryAfter('30', 0)).to.equal(30_000);
            expect(parseRetryAfter(new Date(60_000).toUTCString(), 0)).to.equal(60_000);
            expect(parseRetryAfter('soon', 0)).to.equal(undefined);
            expect(parseRetryAfter(null, 0)).to.equal(undefined);
        });
    });
});
