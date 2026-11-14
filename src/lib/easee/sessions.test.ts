import { expect } from 'chai';
import { SessionReport, SessionStore, parseSessions, sessionCost, type ChargeSession } from './sessions';

// Saturday 14.11.2026 12:00 local (winter, UTC+1) - safely inside the local day
const NOW = Date.parse('2026-11-14T11:00:00Z');
const DAY = 86_400_000;

/**
 * Shape of the real answer (2026-11-14), placeholder IDs and tokens
 *
 * @param id - ID
 * @param connected - carConnected
 * @param kwh - kWh
 * @param more - Overrides
 */
function raw(
    id: number,
    connected: string,
    kwh: number | string,
    more: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        carConnected: connected,
        carDisconnected: '2026-11-13T07:17:24Z',
        kiloWattHours: kwh,
        pricePerKwhExcludingVat: 0,
        pricePrKwhIncludingVat: 0,
        costExcludingVat: 0,
        costIncludingVat: 0,
        actualDurationSeconds: 12278,
        firstEnergyTransferPeriodStarted: '2026-11-12T15:12:35+00:00',
        lastEnergyTransferPeriodEnd: '2026-11-12T18:37:13+00:00',
        id,
        chargerId: 'EH000000',
        isComplete: true,
        authToken: 'placeholder',
        authUser: 1,
        ...more,
    };
}

/**
 * @param id - ID
 * @param start - Start
 * @param kwh - kWh
 * @param more - Overrides
 */
function session(id: number, start: number, kwh: number, more: Partial<ChargeSession> = {}): ChargeSession {
    return { id, start, end: start + 3_600_000, kwh, seconds: 3600, easeeCost: null, complete: true, ...more };
}

describe('easee/sessions', () => {
    it('parses the real answer and drops charger, token and user', () => {
        const list = parseSessions([raw(1, '2026-11-12T15:12:33Z', 24.808369)]);
        expect(list).to.deep.equal([
            {
                id: 1,
                start: Date.parse('2026-11-12T15:12:33Z'),
                end: Date.parse('2026-11-13T07:17:24Z'),
                kwh: 24.808,
                seconds: 12278,
                easeeCost: null,
                complete: true,
            },
        ]);
        expect(JSON.stringify(list)).not.to.match(/EH000000|placeholder|authUser/);
    });

    it('skips broken entries and rejects non-lists', () => {
        expect(parseSessions({ error: 1 })).to.equal(undefined);
        const list = parseSessions([
            null,
            raw(2, 'nonsense', 5, { firstEnergyTransferPeriodStarted: null }),
            raw(3, '2026-11-01T10:00:00Z', -1),
            raw(4, '2026-11-01T10:00:00Z', '7.5'),
            { ...raw(5, '', 3), carConnected: undefined },
        ]);
        expect(list?.map(s => s.id)).to.deep.equal([4, 5]);
        expect(list?.[0].kwh).to.equal(7.5);
        expect(list?.[1].start).to.equal(Date.parse('2026-11-12T15:12:35+00:00'));
    });

    it('takes the Easee cost when set, otherwise the configured price', () => {
        const [withPrice] = parseSessions([raw(1, '2026-11-12T15:12:33Z', 10, { costIncludingVat: 3.333 })]) ?? [];
        expect(sessionCost(withPrice, 0.5)).to.equal(3.33);
        expect(sessionCost(session(2, NOW, 10), 0.4)).to.equal(4);
        expect(sessionCost(session(2, NOW, 10), 0)).to.equal(null);
    });

    it('merges downloads by ID and survives a round trip', () => {
        const store = new SessionStore();
        expect(store.add([session(1, NOW - DAY, 5), session(2, NOW, 6)])).to.equal(2);
        expect(store.add([session(2, NOW, 6)])).to.equal(0);
        expect(store.add([session(2, NOW, 7)])).to.equal(1);
        store.backfilledTo = NOW - 365 * DAY;
        store.backfillDone = true;
        const copy = SessionStore.parse(store.serialize());
        expect(copy.list()).to.deep.equal(store.list());
        expect(copy.backfillDone).to.equal(true);
        expect(copy.backfilledTo).to.equal(NOW - 365 * DAY);
        expect(SessionStore.parse('{broken').size).to.equal(0);
        expect(SessionStore.parse(JSON.stringify({ v: 99, sessions: [] })).backfillDone).to.equal(false);
    });

    it('sums weeks, months and the year', () => {
        const report = new SessionReport(
            [
                session(1, Date.parse('2026-11-12T15:00:00Z'), 24.8), // W46
                session(2, Date.parse('2026-11-03T18:00:00Z'), 20), // W45
                session(3, Date.parse('2026-10-20T18:00:00Z'), 30), // October
                session(4, Date.parse('2025-12-20T18:00:00Z'), 11), // last year
            ],
            0.4,
        );
        const weeks = report.weeks(NOW, 3);
        expect(weeks.map(w => w.period)).to.deep.equal(['2026-W44', '2026-W45', '2026-W46']);
        expect(weeks[2]).to.deep.equal({ period: '2026-W46', sessions: 1, kwh: 24.8, cost: 9.92 });
        expect(weeks[0]).to.deep.equal({ period: '2026-W44', sessions: 0, kwh: 0, cost: 0 });
        const months = report.months(NOW, 13);
        expect(months).to.have.length(13);
        expect(months[0].period).to.equal('2025-11');
        expect(months[12]).to.deep.equal({ period: '2026-11', sessions: 2, kwh: 44.8, cost: 17.92 });
        expect(months[11].kwh).to.equal(30);
        expect(report.year(2026)).to.deep.equal({ period: '2026', sessions: 3, kwh: 74.8, cost: 29.92 });
        expect(report.oldest()).to.equal(Date.parse('2025-12-20T18:00:00Z'));
        expect(report.last()).to.deep.include({ kwh: 24.8, cost: 9.92, minutes: 60 });
    });

    it('sums the last days, today included', () => {
        const report = new SessionReport(
            [session(1, NOW - 60 * 60_000, 12), session(2, NOW - 2 * DAY, 8), session(3, NOW - 20 * DAY, 30)],
            0.5,
        );
        const days = report.days(NOW, 3);
        expect(days).to.have.length(3);
        expect(days[2]).to.deep.include({ sessions: 1, kwh: 12, cost: 6 });
        expect(days[0]).to.deep.include({ sessions: 1, kwh: 8 });
        expect(days[1]).to.deep.include({ sessions: 0, kwh: 0 });
    });

    it('books a session on the local day it started', () => {
        // 31.10. 23:30 UTC = 1.11. 00:30 local (UTC+1)
        const report = new SessionReport([session(1, Date.parse('2026-10-31T23:30:00Z'), 10)], 0);
        const months = report.months(NOW, 2);
        const local = new Date(Date.parse('2026-10-31T23:30:00Z')).getMonth() + 1;
        expect(months.find(m => m.period === `2026-${String(local).padStart(2, '0')}`)?.kwh).to.equal(10);
    });

    it('has no cost without a price', () => {
        const report = new SessionReport([session(1, NOW, 10)], 0);
        expect(report.months(NOW, 1)[0].cost).to.equal(null);
        expect(report.weeks(NOW, 1)[0].cost).to.equal(null);
        expect(new SessionReport([], 0).last()).to.equal(null);
    });
});
