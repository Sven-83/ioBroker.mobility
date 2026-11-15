import { expect } from 'chai';
import { parseManual } from './manual';

// Sunday 15.11.2026 18:00 local
const NOW = new Date(2026, 10, 15, 18).getTime();
const noon = (y: number, m: number, d: number): number => new Date(y, m - 1, d, 12).getTime();

describe('away/manual', () => {
    it('ignores messages that are no "Laden" command', () => {
        expect(parseManual('[Sven]Hallo', NOW)).to.equal(null);
        expect(parseManual('[Sven]Ladestation kaputt', NOW)).to.equal(null);
        expect(parseManual('', NOW)).to.equal(null);
    });

    it('reads kWh, amount and day in any order', () => {
        const want = { kind: 'add', kwh: 14, cost: 5.2, time: noon(2026, 11, 12) };
        for (const text of [
            'Laden 14 kWh 5,20 € 12.11.',
            'Laden 12.11. 14 kWh 5,20 €',
            'laden 5,20€ 12.11. 14kWh',
            'LADEN 5.20 EUR 14 kwh 12.11.2026',
            'Laden 12.11.26 5,2 Euro 14 kWh',
            'Laden 12.11 14 kWh 5,20 €',
        ]) {
            expect(parseManual(`[Sven]${text}`, NOW), text).to.deep.equal(want);
        }
    });

    it('takes 0 EUR and now when amount and day are missing', () => {
        expect(parseManual('[Sven]Laden 14 kWh', NOW)).to.deep.equal({ kind: 'add', kwh: 14, cost: 0, time: NOW });
        expect(parseManual('Laden 14,5 kWh 0 € heute', NOW)).to.deep.equal({
            kind: 'add',
            kwh: 14.5,
            cost: 0,
            time: NOW,
        });
        expect(parseManual('Laden gestern 9 kWh', NOW)).to.deep.equal({
            kind: 'add',
            kwh: 9,
            cost: 0,
            time: noon(2026, 11, 14),
        });
    });

    it('a day without year in the future means last year', () => {
        const result = parseManual('Laden 20 kWh 28.12.', NOW);
        expect(result).to.deep.equal({ kind: 'add', kwh: 20, cost: 0, time: noon(2025, 12, 28) });
    });

    it('takes a message without "Laden" only if it is nothing but kWh, amount and day', () => {
        expect(parseManual('[Sven]12.10.26 20kwh 0€', NOW)).to.deep.equal({
            kind: 'add',
            kwh: 20,
            cost: 0,
            time: noon(2026, 10, 12),
        });
        expect(parseManual('[Sven]14 kWh', NOW)).to.deep.include({ kind: 'add', kwh: 14 });
        expect(parseManual('[Sven]20 kWh bei Max', NOW)).to.equal(null);
        expect(parseManual('[Sven]20 € 12.10.', NOW)).to.equal(null);
        expect(parseManual('[Sven]0 kWh', NOW)).to.equal(null);
        expect(parseManual('[Sven]löschen', NOW)).to.equal(null);
    });

    it('knows the delete command', () => {
        expect(parseManual('[Sven]Laden löschen', NOW)).to.deep.equal({ kind: 'delete' });
        expect(parseManual('Laden loeschen', NOW)).to.deep.equal({ kind: 'delete' });
    });

    it('refuses what it does not understand', () => {
        expect(parseManual('Laden', NOW)).to.deep.equal({ kind: 'invalid', reason: 'kWh missing' });
        expect(parseManual('Laden 14 kWh bei Max', NOW)).to.deep.equal({
            kind: 'invalid',
            reason: '"bei Max" not understood',
        });
        expect(parseManual('Laden 0 kWh', NOW)).to.deep.include({ kind: 'invalid' });
        expect(parseManual('Laden 14 kWh 31.02.', NOW)).to.deep.equal({ kind: 'invalid', reason: 'date not valid' });
        expect(parseManual('Laden 14 kWh 20.12.2026', NOW)).to.deep.equal({
            kind: 'invalid',
            reason: 'date in the future',
        });
    });
});
