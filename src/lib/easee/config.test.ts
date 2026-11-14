import { expect } from 'chai';
import { parseLocalDate, readEaseeConfig } from './config';

describe('easee/config sessions from', () => {
    it('reads the start date as local midnight', () => {
        expect(parseLocalDate('')).to.equal(null);
        expect(parseLocalDate(undefined)).to.equal(null);
        expect(parseLocalDate('2026-10-01')).to.equal(new Date(2026, 9, 1).getTime());
        expect(parseLocalDate('01.10.2026')).to.equal(new Date(2026, 9, 1).getTime());
        expect(parseLocalDate('2026-02-30')).to.equal(undefined);
        expect(parseLocalDate('Oktober')).to.equal(undefined);
    });

    it('reports an invalid date and then uses all sessions', () => {
        const base = { easeeEnabled: true, easeeUser: '+490000000', easeePassword: 'x' };
        expect(readEaseeConfig({ ...base, easeeSessionsFrom: '01.10.2026' }).config.sessionsFrom).to.equal(
            new Date(2026, 9, 1).getTime(),
        );
        const bad = readEaseeConfig({ ...base, easeeSessionsFrom: 'soon' });
        expect(bad.config.sessionsFrom).to.equal(null);
        expect(bad.problems.join(' ')).to.match(/sessions from/);
    });
});
