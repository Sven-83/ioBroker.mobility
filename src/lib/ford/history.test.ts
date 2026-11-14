import { expect } from 'chai';
import { VehicleHistory, dayKey, normaliseTyre, weekKey, type HistorySample } from './history';

const DAY = 86_400_000;
const MIN = 60_000;
// Friday 13.11.2026 11:00 UTC (12:00 local in winter) - safely inside the local day
const T0 = Date.parse('2026-11-13T11:00:00Z');

/**
 * @param t - Time
 * @param more - Overrides
 */
function sample(t: number, more: Partial<HistorySample> = {}): HistorySample {
    return { t, odo: 1000, temp: 10, fuel: null, energy: null, tyres: {}, ...more };
}

describe('ford/history', () => {
    it('builds keys for days and ISO weeks', () => {
        expect(dayKey(T0)).to.equal('2026-11-13');
        expect(weekKey('2026-11-13')).to.equal('2026-W46');
        expect(weekKey('2026-01-01')).to.equal('2026-W01');
        expect(weekKey('2027-01-01')).to.equal('2026-W53');
    });

    it('sums km per week and books trips over 50 km as long distance', () => {
        const h = new VehicleHistory();
        let odo = 1000;
        let t = T0 - 2 * DAY;
        const drive = (kmPerPoll: number[]): void => {
            for (const km of kmPerPoll) {
                odo += km;
                t += 30 * MIN;
                h.add(sample(t, { odo }));
            }
            t += 30 * MIN;
            h.add(sample(t, { odo })); // parked: trip ends
        };
        h.add(sample(t, { odo }));
        drive([12]); // short
        drive([40, 35]); // 75 km long trip over two polls
        drive([20, 25]); // 45 km - still short
        const week = h.weeks(T0, 1, 0)[0];
        expect(week.period).to.equal('2026-W46');
        expect(week.km).to.equal(132);
        expect(week.longKm).to.equal(75);
    });

    it('gives day values, today last', () => {
        const h = new VehicleHistory();
        h.add(sample(T0, { odo: 1000 }));
        h.add(sample(T0 + 30 * MIN, { odo: 1020 }));
        const days = h.dailies(T0 + DAY, 3, 0);
        expect(days).to.have.length(3);
        expect(days[1].km).to.equal(20);
        expect(days[2].km).to.equal(0);
    });

    it('computes kWh/100 km from driving and counts charging separately', () => {
        const h = new VehicleHistory();
        h.add(sample(T0, { odo: 1000, energy: 40 }));
        h.add(sample(T0 + 30 * MIN, { odo: 1050, energy: 31 })); // 9 kWh on 50 km
        h.add(sample(T0 + 60 * MIN, { odo: 1050, energy: 31 }));
        h.add(sample(T0 + 90 * MIN, { odo: 1050, energy: 41.5 })); // charged 10.5 kWh
        h.add(sample(T0 + 120 * MIN, { odo: 1050, energy: 41.6 })); // noise, not charging
        const week = h.weeks(T0 + 2 * DAY, 1, 0)[0];
        expect(week.kwhPer100).to.equal(18);
        expect(week.kwhUsed).to.equal(9);
        expect(week.kmEv).to.equal(50);
        expect(week.kwhCharged).to.equal(10.5);
    });

    it('detects refuels and the consumption between them', () => {
        const h = new VehicleHistory();
        h.add(sample(T0 - 20 * DAY, { odo: 40000, fuel: 20 }));
        h.add(sample(T0 - 20 * DAY + MIN, { odo: 40000, fuel: 95 })); // refuel 1
        h.add(sample(T0 - 5 * DAY, { odo: 40600, fuel: 25 }));
        h.add(sample(T0 - 5 * DAY + MIN, { odo: 40600, fuel: 100 })); // refuel 2: 75 % of 42 l on 600 km
        h.add(sample(T0, { odo: 40700, fuel: 90 })); // driving, no refuel
        expect(h.lastRefuel()).to.deep.equal({ t: T0 - 5 * DAY + MIN, pct: 75, odo: 40600 });
        expect(h.fuelConsumption(42)).to.equal(5.3);
        expect(h.fuelConsumption(0)).to.equal(null);
        const months = h.months(T0, 2, 42);
        expect(months.map(m => m.period)).to.deep.equal(['2026-10', '2026-11']);
        expect(months[0].litres).to.equal(31.5);
        expect(months[1].litres).to.equal(31.5);
    });

    it('sees a slow leak but not a cold night (temperature corrected)', () => {
        expect(normaliseTyre(250, 20)).to.be.closeTo(250, 0.01);
        expect(normaliseTyre(230, 0)).to.be.greaterThan(250); // 2.3 bar at 0 °C ≈ 2.5 bar at 20 °C
        const h = new VehicleHistory();
        for (let i = 0; i <= 6 * 4; i++) {
            const t = T0 - 6 * DAY + i * 6 * 3_600_000;
            const cold = i >= 20; // last day much colder
            const temp = cold ? 0 : 20;
            const physical = (p20: number): number => (p20 + 101.3) * ((temp + 273.15) / 293.15) - 101.3;
            h.add(
                sample(t, {
                    temp,
                    tyres: {
                        frontLeft: physical(250), // only colder, not leaking
                        rearLeft: physical(250 - i * 1.5), // loses 36 kPa over 6 days
                    },
                }),
            );
        }
        const loss = h.tyreLoss(T0);
        expect(loss).to.have.keys(['rearLeft']);
        expect(loss.rearLeft).to.be.within(28, 36);
    });

    it('needs three days of data for a tyre trend', () => {
        const h = new VehicleHistory();
        h.add(sample(T0 - DAY, { tyres: { frontLeft: 250 } }));
        h.add(sample(T0, { tyres: { frontLeft: 200 } }));
        expect(h.tyreLoss(T0)).to.deep.equal({});
    });

    it('ignores repeated vehicle times and survives a restart', () => {
        const h = new VehicleHistory();
        h.add(sample(T0, { odo: 1000 }));
        h.add(sample(T0 + 30 * MIN, { odo: 1060 }));
        h.add(sample(T0 + 30 * MIN, { odo: 1060 })); // same report again
        const restored = VehicleHistory.parse(h.serialize());
        expect(restored.ok).to.equal(true);
        restored.history.add(sample(T0 + 60 * MIN, { odo: 1060 })); // trip ends after restart
        const week = restored.history.weeks(T0, 1, 0)[0];
        expect(week.km).to.equal(60);
        expect(week.longKm).to.equal(60);
        expect(VehicleHistory.parse('{broken').ok).to.equal(false);
        expect(VehicleHistory.parse(undefined).ok).to.equal(true);
    });

    it('keeps raw samples for 8 days only', () => {
        const h = new VehicleHistory();
        for (let d = 20; d >= 0; d--) {
            h.add(sample(T0 - d * DAY, { tyres: { frontLeft: 250 } }));
        }
        const stored = JSON.parse(h.serialize()) as { samples: unknown[]; days: unknown[] };
        expect(stored.samples).to.have.length(9);
        expect(stored.days).to.have.length(21);
    });
});
