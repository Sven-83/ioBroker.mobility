import { expect } from 'chai';
import { readEaseeConfig, DEFAULT_INTERVAL_SEC, DEFAULT_PRICE_PER_KWH, MIN_INTERVAL_SEC } from './config';
import { parseChargerCommandId } from './objects';
import { OBS, isCarConnected, parseChargerState, reasonText, toBoolean, toNumber } from './observations';

const T1 = '2026-11-05T10:00:00.000Z';
const T2 = '2026-11-05T10:00:05.000Z';

describe('easee/observations', () => {
    it('parses a charging charger and coerces swapped types', () => {
        const state = parseChargerState([
            { id: OBS.opMode, value: 3, timestamp: T1 },
            { id: OBS.connectedToCloud, value: true, timestamp: T1 },
            { id: OBS.totalPower, value: 11.0423, timestamp: T2 },
            { id: OBS.sessionEnergy, value: '4.5678', timestamp: T1 },
            { id: OBS.lifetimeEnergy, value: 1234.5, timestamp: T1 },
            { id: OBS.outputCurrent, value: 16.02, timestamp: T1 }, // documented Integer, arrives Double
            { id: OBS.cableLocked, value: 1, timestamp: T1 },
            { id: OBS.authorizationRequired, value: 'false', timestamp: T1 },
            { id: 9999, value: 'ignored', timestamp: T1 },
        ]);
        expect(state.opMode).to.equal(3);
        expect(state.online).to.equal(true);
        expect(state.power).to.equal(11.042);
        expect(state.sessionEnergy).to.equal(4.568);
        expect(state.outputCurrent).to.equal(16);
        expect(state.cableLocked).to.equal(true);
        expect(state.authorizationRequired).to.equal(false);
        expect(state.smartCharging).to.equal(null);
        expect(state.latestPulse).to.equal(Date.parse(T2));
    });

    it('rejects unknown op modes and empty answers', () => {
        expect(parseChargerState([{ id: OBS.opMode, value: 42, timestamp: T1 }]).opMode).to.equal(null);
        const empty = parseChargerState([]);
        expect(empty.opMode).to.equal(null);
        expect(empty.latestPulse).to.equal(null);
    });

    it('coercion helpers', () => {
        expect(toNumber('x')).to.equal(null);
        expect(toNumber('')).to.equal(null);
        expect(toNumber(true)).to.equal(1);
        expect(toBoolean('TRUE')).to.equal(true);
        expect(toBoolean(0)).to.equal(false);
        expect(toBoolean('maybe')).to.equal(null);
    });

    it('car connected and reason texts', () => {
        expect(isCarConnected(1)).to.equal(false);
        expect(isCarConnected(2)).to.equal(true);
        expect(isCarConnected(null)).to.equal(null);
        expect(reasonText(0)).to.equal('OK');
        // real charge 2026-11-05: a 25-30 code while charging is a limit, not an error
        expect(reasonText(29)).to.equal('Limited by load balancing');
        expect(reasonText(50)).to.equal('No car connected or no current request');
        expect(reasonText(79)).to.equal('EV is not charging');
        expect(reasonText(42)).to.equal('Code 42');
        expect(reasonText(null)).to.equal('');
    });
});

describe('easee/config', () => {
    it('needs the switch, user name and password', () => {
        expect(readEaseeConfig({ easeeEnabled: true, easeeUser: 'u', easeePassword: 'p' }).config.enabled).to.equal(
            true,
        );
        expect(readEaseeConfig({ easeeUser: 'u', easeePassword: 'p' }).config.enabled).to.equal(false);
        const missing = readEaseeConfig({ easeeEnabled: true, easeeUser: ' ', easeePassword: 'secret' });
        expect(missing.config.enabled).to.equal(false);
        expect(missing.problems.join()).to.contain('missing');
        expect(missing.problems.join()).not.to.contain('secret');
    });

    it('keeps spaces inside the password but strips pasted line breaks', () => {
        const { config } = readEaseeConfig({ easeeEnabled: true, easeeUser: 'u', easeePassword: 'a b\r\n' });
        expect(config.password).to.equal('a b');
    });

    it('reads the charger names and drops duplicates', () => {
        const { config, problems } = readEaseeConfig({ easeeCharger1: ' Space A1 ', easeeCharger2: 'space a1' });
        expect(config.chargerNames).to.deep.equal(['Space A1', '']);
        expect(problems.join()).to.contain('same name');
        expect(readEaseeConfig({}).config.chargerNames).to.deep.equal(['', '']);
    });

    it('hints at the country code for phone numbers without it', () => {
        const hint = (user: string): boolean =>
            readEaseeConfig({ easeeEnabled: true, easeeUser: user, easeePassword: 'p' }).problems.some(p =>
                p.includes('country code'),
            );
        expect(hint('0000 1111111')).to.equal(true);
        expect(hint('0001111111')).to.equal(true);
        expect(hint('+490001111111')).to.equal(false);
        expect(hint('user@example.invalid')).to.equal(false);
        const problems = readEaseeConfig({ easeeEnabled: true, easeeUser: '0001111111', easeePassword: 'p' }).problems;
        expect(problems.join()).not.to.contain('0001111111');
    });

    it('clamps interval and validates the price', () => {
        expect(readEaseeConfig({}).config.intervalSec).to.equal(DEFAULT_INTERVAL_SEC);
        expect(readEaseeConfig({ easeeInterval: 5 }).config.intervalSec).to.equal(MIN_INTERVAL_SEC);
        expect(readEaseeConfig({}).config.pricePerKwh).to.equal(DEFAULT_PRICE_PER_KWH);
        const bad = readEaseeConfig({ easeePrice: -1 });
        expect(bad.config.pricePerKwh).to.equal(0);
        expect(bad.problems).to.have.length(1);
    });
});

describe('easee/objects', () => {
    it('parses command IDs', () => {
        expect(parseChargerCommandId('mobility.0', 'mobility.0.easee.charger2.charge')).to.deep.equal({
            slot: 2,
            command: 'charge',
        });
        expect(parseChargerCommandId('mobility.0', 'mobility.0.easee.charger1.refresh')?.command).to.equal('refresh');
        expect(parseChargerCommandId('mobility.0', 'mobility.0.easee.charger1.power')).to.equal(undefined);
        expect(parseChargerCommandId('mobility.0', 'mobility.0.easee.chargerX.charge')).to.equal(undefined);
        expect(parseChargerCommandId('mobility.0', 'mobility.1.easee.charger1.charge')).to.equal(undefined);
    });
});
