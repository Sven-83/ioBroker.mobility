import { expect } from 'chai';
import { decimal, money, parseReceipt, receiptTime, rowTime } from './receipt';

/**
 * Text pieces in the order of a real receipt (2026-10-31), anonymised: placeholder number,
 * user, charge point and address.
 *
 * @param discount - With the discount lines
 */
function pieces(discount: boolean): string[] {
    return [
        'Octopus Electroverse Ltd',
        'W',
        'electroverse.com',
        'Beleg für den Ladevorgang',
        'Belegdatum: 31st Okt. 2026',
        'Benutzer',
        'user@example.invalid',
        'EVSE',
        'DE*XXX*E00000*001',
        'Beleg',
        '1000001',
        'Anbieter',
        'Netz A',
        'Start des Ladevorgangs',
        '31st Okt. 2026 14:03:42',
        'Adresse',
        'Musterweg 1',
        'Ende des Ladevorgangs',
        '31st Okt. 2026 14:29:56',
        'Musterstadt',
        'Geschätzte CO2-Einsparung',
        '7,08kg',
        '00000, DEU',
        'Zeitraum von',
        'Zeitraum bis',
        'Einheitstyp',
        'Netto',
        'MwSt.',
        'Brutto',
        '14:03 31/10/26',
        '14:29 31/10/26',
        'Verbrauch [kWh]',
        '0,6803 €',
        '27,02',
        '15,45 €',
        '2,93 €',
        '18,38 €',
        '14:03 31/10/26',
        '14:29 31/10/26',
        'Ladezeit [min]',
        '0,00 €',
        '26,00',
        '0,00 €',
        '0,00 €',
        '0,00 €',
        ...(discount
            ? ['Zwischensumme', '15,45 €', '2,93 €', '18,38 €', 'Rabatt', '-6,18 €', '-1,17 €', '-7,35 €']
            : []),
        'Gesamt',
        discount ? '9,27 €' : '15,45 €',
        discount ? '1,76 €' : '2,93 €',
        discount ? '11,03 €' : '18,38 €',
        'Zu zahlender Betrag',
        discount ? '11,03 €' : '18,38 €',
        'Wechselkurs',
        'EUR = 1,000 EUR',
    ];
}

describe('away/receipt', () => {
    it('reads amounts and numbers in German style', () => {
        expect(money('11,03 €')).to.equal(11.03);
        expect(money('-7,35 €')).to.equal(-7.35);
        expect(money('1.234,5 €')).to.equal(1234.5);
        expect(money('0,6803 €')).to.equal(0.6803);
        expect(money('12 EUR')).to.equal(12);
        expect(money('11,03')).to.equal(null);
        expect(money(undefined)).to.equal(null);
        expect(decimal('27,02')).to.equal(27.02);
        expect(decimal('1.027,5')).to.equal(1027.5);
        expect(decimal('7,08kg')).to.equal(null);
    });

    it('reads the mixed date format of the receipt and the table rows', () => {
        expect(receiptTime('31st Okt. 2026 14:03:42')).to.equal(new Date(2026, 9, 31, 14, 3, 42).getTime());
        expect(receiptTime('2nd Mär. 2027 08:05:00')).to.equal(new Date(2027, 2, 2, 8, 5, 0).getTime());
        expect(receiptTime('3rd Dec 2026 23:59')).to.equal(new Date(2026, 11, 3, 23, 59, 0).getTime());
        expect(receiptTime('31st Feb. 2026 10:00:00')).to.equal(null);
        expect(receiptTime('31st Xyz. 2026 10:00:00')).to.equal(null);
        expect(rowTime('14:03 31/10/26')).to.equal(new Date(2026, 9, 31, 14, 3).getTime());
        expect(rowTime('25:03 31/10/26')).to.equal(null);
    });

    it('takes over a receipt with discount: amount paid, discount and price', () => {
        const result = parseReceipt(pieces(true));
        expect(result).to.deep.equal({
            ok: true,
            receipt: {
                id: 1000001,
                start: new Date(2026, 9, 31, 14, 3, 42).getTime(),
                end: new Date(2026, 9, 31, 14, 29, 56).getTime(),
                kwh: 27.02,
                paid: 11.03,
                discount: 7.35,
                pricePerKwh: 0.6803,
                provider: 'Netz A',
            },
        });
        // no e-mail, charge point or address in the result
        expect(JSON.stringify(result)).not.to.match(/example|XXX|Muster/);
    });

    it('takes over a receipt without discount', () => {
        const result = parseReceipt(pieces(false));
        expect(result.ok && result.receipt.paid).to.equal(18.38);
        expect(result.ok && result.receipt.discount).to.equal(0);
    });

    it('falls back to the table row when the header date is not readable', () => {
        const list = pieces(false).map(p => (p.startsWith('31st Okt.') ? '31.10.2026' : p));
        const result = parseReceipt(list);
        expect(result.ok && result.receipt.start).to.equal(new Date(2026, 9, 31, 14, 3).getTime());
        expect(result.ok && result.receipt.end).to.equal(new Date(2026, 9, 31, 14, 29).getTime());
    });

    it('tells foreign PDFs from receipts with a missing value', () => {
        expect(parseReceipt(['Rechnung', 'Zu zahlender Betrag', '5,00 €'])).to.deep.include({
            ok: false,
            kind: 'foreign',
        });
        const noAmount = pieces(false).filter(p => p !== 'Zu zahlender Betrag');
        expect(parseReceipt(noAmount)).to.deep.equal({ ok: false, kind: 'broken', reason: 'amount missing' });
        const noNumber = pieces(false).map(p => (p === '1000001' ? 'x' : p));
        expect(parseReceipt(noNumber)).to.deep.include({ ok: false, kind: 'broken' });
        const zeroKwh = pieces(false).map(p => (p === '27,02' ? '0,00' : p));
        expect(parseReceipt(zeroKwh)).to.deep.equal({ ok: false, kind: 'broken', reason: 'energy missing' });
    });
});
