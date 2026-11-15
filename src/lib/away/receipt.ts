/*
 * Charging receipt of Octopus Electroverse ("Beleg für den Ladevorgang", one PDF per session).
 *
 * Checked with two real receipts (2026-10-31). The text pieces come in this order:
 *   ... "Beleg" <number> "Anbieter" <provider> "Start des Ladevorgangs" "31st Okt. 2026 14:03:42" ...
 *   "Ende des Ladevorgangs" "31st Okt. 2026 14:29:56" ...
 *   "14:03 31/10/26" "14:29 31/10/26" "Verbrauch [kWh]" <price/kWh> <kWh> <net> <VAT> <gross> ...
 *   ["Rabatt" <net> <VAT> <gross>] ... "Zu zahlender Betrag" <amount>
 * Kept: receipt number, start, end, kWh, provider, price per kWh, discount, amount paid.
 * Dropped right here: user (e-mail), address, charge point (EVSE).
 *
 * Subscription invoice ("Ladeanbieter Abonnement-Rechnung", checked 2026-11-15, IONITY 40 % discount):
 *   ... "Anbieter" <provider> "Beleg" <number> ... "Beginn des Abonnementzeitraums" "31st Okt. 2026" ...
 *   "Ende des Abonnementzeitraums" "29th Nov. 2026" ... "Gesamt (inkl. MwSt.)" <amount>
 * It is kept with kind "subscription", 0 kWh and the amount (owner 2026-11-15: subscriptions count as
 * costs on the road, booked on the first day of the period).
 */

/** One charging session on the road */
export interface AwayReceipt {
    /** Receipt number (also the key against duplicates) */
    id: number;
    /** Start (epoch ms, local time of the ioBroker host) */
    start: number;
    /** End (epoch ms) */
    end: number;
    /** Energy in kWh */
    kwh: number;
    /** Amount paid incl. VAT in EUR (after discount) */
    paid: number;
    /** Discount incl. VAT in EUR, 0 without */
    discount: number;
    /** Price per kWh in EUR as printed (net or gross, as the receipt shows it), null if missing */
    pricePerKwh: number | null;
    /** Charging network, e.g. IONITY; empty if missing */
    provider: string;
    /** "subscription" for a subscription invoice (start/end = period, 0 kWh); missing = charging session */
    kind?: 'subscription';
}

/** Result of reading a receipt */
export type ReceiptResult =
    | { ok: true; receipt: AwayReceipt }
    /**
     * foreign = no Electroverse PDF at all, other = Electroverse PDF of an unknown kind,
     * broken = looks like a receipt but a value is missing
     */
    | { ok: false; kind: 'foreign' | 'other' | 'broken'; reason: string };

const MONTHS: Record<string, number> = {
    jan: 1,
    feb: 2,
    mär: 3,
    mar: 3,
    mrz: 3,
    apr: 4,
    mai: 5,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    okt: 10,
    oct: 10,
    nov: 11,
    dez: 12,
    dec: 12,
};

const MAX_SESSION_MS = 48 * 3_600_000;

/**
 * Amount like "11,03 €", "-7,35 €", "1.234,56 €" or "0,6803 €".
 *
 * @param s - Text piece
 * @returns EUR, null if it is no amount
 */
export function money(s: string | undefined): number | null {
    const m = /^(-?)\s*(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d+))?\s*(?:€|EUR)$/.exec((s ?? '').trim());
    if (!m) {
        return null;
    }
    const value = Number(`${m[2].replace(/\./g, '')}.${m[3] ?? '0'}`);
    return m[1] ? -value : value;
}

/**
 * Number like "27,02" or "1.027,5".
 *
 * @param s - Text piece
 */
export function decimal(s: string | undefined): number | null {
    const m = /^(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d+))?$/.exec((s ?? '').trim());
    return m ? Number(`${m[1].replace(/\./g, '')}.${m[2] ?? '0'}`) : null;
}

/**
 * Date and time like "31st Okt. 2026 14:03:42" (local time); without time = midnight.
 *
 * @param s - Text piece
 * @returns Epoch ms, null if not readable
 */
export function receiptTime(s: string | undefined): number | null {
    const m =
        /^(\d{1,2})(?:st|nd|rd|th)?\.?\s+([A-Za-zÄÖÜäöü]{3,})\.?\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(
            (s ?? '').trim(),
        );
    const month = m ? MONTHS[m[2].slice(0, 3).toLowerCase()] : undefined;
    if (!m || !month) {
        return null;
    }
    return checkedDate(Number(m[3]), month, Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
}

/**
 * Time of a table row like "14:03 31/10/26".
 *
 * @param s - Text piece
 */
export function rowTime(s: string | undefined): number | null {
    const m = /^(\d{1,2}):(\d{2})\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec((s ?? '').trim());
    if (!m) {
        return null;
    }
    const year = m[5].length === 2 ? 2000 + Number(m[5]) : Number(m[5]);
    return checkedDate(year, Number(m[4]), Number(m[3]), Number(m[1]), Number(m[2]), 0);
}

function checkedDate(y: number, mo: number, d: number, h: number, mi: number, s: number): number | null {
    const date = new Date(y, mo - 1, d, h, mi, s);
    return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d && h < 24 && mi < 60
        ? date.getTime()
        : null;
}

/**
 * Reads the values of an Electroverse charging receipt from its text pieces.
 *
 * @param pieces - Text pieces in content order (see pdf-text.ts)
 */
export function parseReceipt(pieces: string[]): ReceiptResult {
    const isElectroverse = pieces.some(p => /electroverse/i.test(p));
    const after = (label: RegExp, offset = 1): string | undefined => {
        const i = pieces.findIndex(p => label.test(p));
        return i < 0 ? undefined : pieces[i + offset];
    };
    if (!isElectroverse) {
        return { ok: false, kind: 'foreign', reason: 'no Electroverse PDF' };
    }
    const broken = (reason: string): ReceiptResult => ({ ok: false, kind: 'broken', reason });
    const provider = (after(/^Anbieter$/) ?? '').slice(0, 60);
    const kwhRow = pieces.findIndex(p => /^Verbrauch\s*\[kWh\]$/i.test(p));
    if (kwhRow < 0) {
        if (!pieces.some(p => /Abonnement-Rechnung/i.test(p))) {
            return { ok: false, kind: 'other', reason: 'neither charging receipt nor subscription invoice' };
        }
        const number = Number(after(/^Beleg$/));
        if (!Number.isSafeInteger(number) || number <= 0) {
            return broken('receipt number missing');
        }
        const from = receiptTime(after(/^Beginn des Abonnementzeitraums$/));
        const to = receiptTime(after(/^Ende des Abonnementzeitraums$/));
        if (from === null || to === null || to < from) {
            return broken('subscription period missing');
        }
        const amount = money(after(/^Gesamt \(inkl\. MwSt\.\)$/));
        if (amount === null || amount < 0 || amount > 500) {
            return broken('amount missing');
        }
        return {
            ok: true,
            receipt: {
                id: number,
                start: from,
                end: to,
                kwh: 0,
                paid: Math.round(amount * 100) / 100,
                discount: 0,
                pricePerKwh: null,
                provider: provider === 'Beleg' ? '' : provider,
                kind: 'subscription',
            },
        };
    }

    const id = Number(after(/^Beleg$/));
    if (!Number.isSafeInteger(id) || id <= 0) {
        return broken('receipt number missing');
    }
    const start = receiptTime(after(/^Start des Ladevorgangs$/)) ?? rowTime(pieces[kwhRow - 2]);
    const end = receiptTime(after(/^Ende des Ladevorgangs$/)) ?? rowTime(pieces[kwhRow - 1]);
    if (start === null || end === null || end < start || end - start > MAX_SESSION_MS) {
        return broken('start or end missing');
    }
    const kwh = decimal(pieces[kwhRow + 2]);
    if (kwh === null || kwh <= 0 || kwh > 500) {
        return broken('energy missing');
    }
    const paid = money(after(/^Zu zahlender Betrag$/));
    if (paid === null || paid < 0 || paid > 2_000) {
        return broken('amount missing');
    }
    const discountGross = money(after(/^Rabatt$/, 3));
    return {
        ok: true,
        receipt: {
            id,
            start,
            end,
            kwh: Math.round(kwh * 100) / 100,
            paid: Math.round(paid * 100) / 100,
            discount: discountGross === null ? 0 : Math.round(Math.abs(discountGross) * 100) / 100,
            pricePerKwh: money(pieces[kwhRow + 1]),
            provider: /^(Adresse|Start des Ladevorgangs)$/.test(provider) ? '' : provider,
        },
    };
}
