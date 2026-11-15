import { expect } from 'chai';
import { AwayService, awayObjects, describeReceipt, parseStore, type AwayDeps } from './away-service';
import type { AwayReceipt } from './receipt';

// Sunday 15.11.2026 12:00 local
const NOW = new Date(2026, 10, 15, 12).getTime();

/**
 * @param id - Receipt number
 * @param start - Start
 * @param kwh - kWh
 * @param paid - EUR
 */
function receipt(id: number, start: Date, kwh: number, paid: number): AwayReceipt {
    return {
        id,
        start: start.getTime(),
        end: start.getTime() + 20 * 60_000,
        kwh,
        paid,
        discount: 0,
        pricePerKwh: 0.69,
        provider: 'Netz A',
    };
}

/**
 * Service with fake adapter functions
 *
 * @param file - Content of the receipt file, undefined = none
 */
function setup(file?: string): {
    service: AwayService;
    states: Map<string, ioBroker.StateValue>;
    saved: string[];
    timers: (() => void)[];
    objects: string[];
} {
    const states = new Map<string, ioBroker.StateValue>();
    const saved: string[] = [];
    const timers: (() => void)[] = [];
    const objects: string[] = [];
    const deps: AwayDeps = {
        log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
        now: () => NOW,
        setTimeout: callback => {
            timers.push(callback);
            return timers.length;
        },
        clearTimeout: () => undefined,
        ensureObjects: definitions => {
            objects.push(...definitions.map(d => d.id));
            return Promise.resolve();
        },
        setState: (id, value) => {
            states.set(id, value);
            return Promise.resolve();
        },
        load: () => Promise.resolve(file),
        save: text => {
            saved.push(text);
            return Promise.resolve();
        },
    };
    return { service: new AwayService(deps, true), states, saved, timers, objects };
}

describe('away/away-service', () => {
    it('creates the objects like easee.history, without lastSync', () => {
        const ids = awayObjects().map(d => d.id);
        expect(ids).to.include.members(['away', 'away.lastReceipt', 'away.history.weeks', 'away.history.yearCost']);
        expect(ids.some(id => id.endsWith('lastSync'))).to.equal(false);
    });

    it('starts empty and writes an evaluation with zeros', async () => {
        const t = setup();
        await t.service.start();
        expect(t.states.get('away.history.sessionCount')).to.equal(0);
        expect(t.states.get('away.history.yearCost')).to.equal(0);
        expect(t.states.get('away.history.lastSession')).to.equal(null);
        expect(JSON.parse(String(t.states.get('away.history.weeks')))).to.have.length(12);
    });

    it('adds receipts, keeps them in the file and sums days, weeks and months', async () => {
        const t = setup();
        await t.service.start();
        expect(await t.service.add(receipt(1, new Date(2026, 9, 31, 13, 16), 14.09, 10.99))).to.equal('added');
        expect(await t.service.add(receipt(2, new Date(2026, 10, 14, 9, 0), 27.02, 11.03))).to.equal('added');
        expect(await t.service.add(receipt(2, new Date(2026, 10, 14, 9, 0), 27.02, 11.03))).to.equal('duplicate');
        expect(t.saved).to.have.length(2);
        expect(parseStore(t.saved[1]).map(r => r.id)).to.deep.equal([1, 2]);

        expect(t.states.get('away.history.sessionCount')).to.equal(2);
        expect(t.states.get('away.history.monthEnergy')).to.equal(27);
        expect(t.states.get('away.history.monthCost')).to.equal(11.03);
        expect(t.states.get('away.history.yearCost')).to.equal(22.02);
        const months = JSON.parse(String(t.states.get('away.history.months'))) as { period: string; kwh: number }[];
        expect(months.find(m => m.period === '2026-10')?.kwh).to.equal(14.1);
        const days = JSON.parse(String(t.states.get('away.history.days'))) as { period: string; cost: number }[];
        expect(days.find(d => d.period === '2026-11-14')?.cost).to.equal(11.03);
        expect(t.states.get('away.lastReceipt')).to.equal('14.11.2026 09:00 · Netz A · 27,02 kWh · 11,03 €');
    });

    it('reads the stored receipts back and drops broken entries', async () => {
        const file = JSON.stringify({
            version: 1,
            receipts: [receipt(5, new Date(2026, 10, 1, 10), 20, 9), { id: 'x' }, null],
        });
        const t = setup(file);
        await t.service.start();
        expect(t.service.count).to.equal(1);
        expect(parseStore('not json')).to.deep.equal([]);
        expect(parseStore(undefined)).to.deep.equal([]);
    });

    it('writes the evaluation again every hour (periods roll over)', async () => {
        const t = setup();
        await t.service.start();
        t.states.clear();
        t.timers[0]();
        await new Promise(r => setTimeout(r, 0));
        expect(t.states.has('away.history.days')).to.equal(true);
        expect(t.timers).to.have.length(2);
    });

    it('describes a receipt in English too', () => {
        const r = { ...receipt(1, new Date(2026, 9, 31, 14, 3), 27.02, 11.03), provider: '' };
        expect(describeReceipt(r, false)).to.equal('31/10/2026 14:03 · 27.02 kWh · 11.03 €');
    });
});
