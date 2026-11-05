import { expect } from 'chai';
import { DEFAULT_INTERVAL_MIN, MIN_INTERVAL_MIN, readFuelConfig } from './config';

const KEY = '00000000-0000-0000-0000-00000000000a';
const S1 = '00000000-0000-0000-0000-000000000001';
const S2 = '00000000-0000-0000-0000-000000000002';

describe('fuel/config', () => {
    it('accepts two stations', () => {
        const { config, problems } = readFuelConfig({
            fuelEnabled: true,
            fuelApiKey: ` ${KEY.toUpperCase()} `,
            fuelStation1Name: ' Nord ',
            fuelStation1Id: S1.toUpperCase(),
            fuelStation2Name: 'Süd',
            fuelStation2Id: S2,
            fuelInterval: 15,
        });
        expect(problems).to.deep.equal([]);
        expect(config).to.deep.equal({
            enabled: true,
            apiKey: KEY,
            stations: [
                { id: S1, name: 'Nord', slot: 1 },
                { id: S2, name: 'Süd', slot: 2 },
            ],
            intervalMin: 15,
        });
    });

    it('keeps the slot number when only station 2 is filled', () => {
        const { config } = readFuelConfig({ fuelApiKey: KEY, fuelStation2Id: S2 });
        expect(config.stations).to.deep.equal([{ id: S2, name: 'Station 2', slot: 2 }]);
        expect(config.enabled).to.equal(true);
    });

    it('stays off without key or stations', () => {
        expect(readFuelConfig({ fuelApiKey: KEY }).config.enabled).to.equal(false);
        expect(readFuelConfig({ fuelApiKey: '', fuelStation1Id: S1 }).config.enabled).to.equal(false);
        expect(readFuelConfig({ fuelEnabled: false, fuelApiKey: KEY, fuelStation1Id: S1 }).config.enabled).to.equal(
            false,
        );
    });

    it('reports a malformed key without echoing it', () => {
        const { config, problems } = readFuelConfig({ fuelApiKey: 'secret-value', fuelStation1Id: S1 });
        expect(config.enabled).to.equal(false);
        expect(problems.join()).to.contain('invalid format');
        expect(problems.join()).not.to.contain('secret');
    });

    it('skips an invalid ID and a duplicate', () => {
        const invalid = readFuelConfig({ fuelApiKey: KEY, fuelStation1Id: 'not-a-uuid', fuelStation2Id: S2 });
        expect(invalid.config.stations.map(s => s.slot)).to.deep.equal([2]);
        expect(invalid.problems).to.have.length(1);
        const duplicate = readFuelConfig({ fuelApiKey: KEY, fuelStation1Id: S1, fuelStation2Id: S1 });
        expect(duplicate.config.stations).to.have.length(1);
        expect(duplicate.problems.join()).to.contain('same ID');
    });

    it('clamps the interval and uses the default', () => {
        expect(readFuelConfig({ fuelInterval: 1 }).config.intervalMin).to.equal(MIN_INTERVAL_MIN);
        expect(readFuelConfig({ fuelInterval: 500 }).config.intervalMin).to.equal(60);
        expect(readFuelConfig({}).config.intervalMin).to.equal(DEFAULT_INTERVAL_MIN);
    });
});
