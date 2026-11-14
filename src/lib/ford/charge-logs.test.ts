import { expect } from 'chai';
import { chargeLogDue, countEntries, isoDay, sanitizeChargeLogs } from './charge-logs';

describe('ford/charge-logs', () => {
    it('removes car and place, keeps the charge data', () => {
        const answer = {
            energyTransferLogs: [
                {
                    deviceId: 'X',
                    eventType: 'ChargeData',
                    chargerType: 'DC_FAST',
                    energyConsumed: 41.2,
                    stateOfCharge: { firstSOC: 20, lastSOC: 80 },
                    location: {
                        type: 'PUBLIC',
                        name: 'Home',
                        latitude: 1,
                        longitude: 2,
                        network: 'X-NET',
                        address: { city: 'Y' },
                    },
                },
            ],
        };
        expect(sanitizeChargeLogs(answer)).to.deep.equal({
            energyTransferLogs: [
                {
                    eventType: 'ChargeData',
                    chargerType: 'DC_FAST',
                    energyConsumed: 41.2,
                    stateOfCharge: { firstSOC: 20, lastSOC: 80 },
                    location: { type: 'PUBLIC', network: 'X-NET' },
                },
            ],
        });
        expect(countEntries(sanitizeChargeLogs(answer))).to.equal(1);
    });
    it('counts a plain list and nothing', () => {
        expect(countEntries([1, 2])).to.equal(2);
        expect(countEntries(null)).to.equal(0);
    });
    it('local day', () => {
        expect(isoDay(new Date(2026, 10, 3, 23, 30).getTime())).to.equal('2026-11-03');
    });
    it("is due once per day after 4 o'clock", () => {
        const at = (d: number, h: number, m = 0): number => new Date(2026, 10, d, h, m).getTime();
        expect(chargeLogDue(at(14, 20), at(14, 23))).to.equal(false); // started in the evening
        expect(chargeLogDue(at(14, 20), at(15, 3, 59))).to.equal(false);
        expect(chargeLogDue(at(14, 20), at(15, 4, 5))).to.equal(true);
        expect(chargeLogDue(at(15, 4, 5), at(15, 18))).to.equal(false); // read this morning
        expect(chargeLogDue(at(15, 4, 5), at(16, 4, 1))).to.equal(true);
    });
});
