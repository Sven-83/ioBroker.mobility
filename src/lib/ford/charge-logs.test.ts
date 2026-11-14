import { expect } from 'chai';
import { countEntries, isoDay, sanitizeChargeLogs } from './charge-logs';

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
});
