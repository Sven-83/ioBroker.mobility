/*
 * Charging on the road typed into Telegram (owner 2026-11-15), e.g. at friends or at a free charger:
 *   "Laden 14 kWh"               14 kWh, 0 EUR, now
 *   "Laden 14 kWh 5,20 €"        with price
 *   "Laden 12.11. 14 kWh 0 €"    on a day; the parts may come in any order
 *   "Laden löschen"              removes the last typed entry
 * Day: "12.11.", "12.11.26", "12.11.2026", "heute", "gestern". A day without year in the future
 * means last year. Text that does not start with "Laden" is no command (the bot is used for other things).
 */

/** What a message asks for */
export type ManualCommand =
    { kind: 'add'; kwh: number; cost: number; time: number } | { kind: 'delete' } | { kind: 'invalid'; reason: string };

const DAY_MS = 86_400_000;

/**
 * Number like "14", "14,5" or "14.5".
 *
 * @param s - Digits
 */
function number(s: string): number {
    return Number(s.replace(',', '.'));
}

/**
 * Reads a "Laden ..." message.
 *
 * @param message - Value of communicate.request, e.g. "[Name]Laden 14 kWh"
 * @param now - Current time
 * @returns The command, null if the message is no "Laden" command
 */
export function parseManual(message: string, now: number): ManualCommand | null {
    const body = message.replace(/^\[[^\]]*\]/, '').trim();
    const m = /^laden(?:\s+|$)([\s\S]*)$/i.exec(body);
    if (!m) {
        return null;
    }
    let rest = ` ${m[1].trim()} `;
    if (/^\s*(löschen|loeschen)\s*$/i.test(rest)) {
        return { kind: 'delete' };
    }
    const take = (re: RegExp): RegExpExecArray | null => {
        const found = re.exec(rest);
        if (found) {
            rest = `${rest.slice(0, found.index)} ${rest.slice(found.index + found[0].length)}`;
        }
        return found;
    };
    const kwhMatch = take(/(?<=\s)(\d{1,3}(?:[.,]\d{1,3})?)\s*kwh(?=\s)/i);
    const costMatch = take(/(?<=\s)(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:€|eur|euro)(?=\s)/i);
    const dateMatch = take(/(?<=\s)(\d{1,2})\.(\d{1,2})(?:\.(\d{4}|\d{2})?)?(?=\s)/);
    const wordMatch = dateMatch ? null : take(/(?<=\s)(heute|gestern)(?=\s)/i);

    if (rest.trim()) {
        return { kind: 'invalid', reason: `"${rest.trim()}" not understood` };
    }
    if (!kwhMatch) {
        return { kind: 'invalid', reason: 'kWh missing' };
    }
    const kwh = number(kwhMatch[1]);
    if (!(kwh > 0 && kwh <= 200)) {
        return { kind: 'invalid', reason: 'kWh out of range (0-200)' };
    }
    const cost = costMatch ? number(costMatch[1]) : 0;
    if (!(cost >= 0 && cost <= 500)) {
        return { kind: 'invalid', reason: 'amount out of range' };
    }

    let time = now;
    if (dateMatch) {
        const today = new Date(now);
        const day = Number(dateMatch[1]);
        const month = Number(dateMatch[2]);
        const y = dateMatch[3];
        let year = y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : today.getFullYear();
        let date = new Date(year, month - 1, day, 12);
        if (!y && date.getTime() > now) {
            year--;
            date = new Date(year, month - 1, day, 12);
        }
        if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
            return { kind: 'invalid', reason: 'date not valid' };
        }
        if (date.getTime() > now + DAY_MS) {
            return { kind: 'invalid', reason: 'date in the future' };
        }
        time = date.getTime();
    } else if (wordMatch && wordMatch[1].toLowerCase() === 'gestern') {
        const d = new Date(now - DAY_MS);
        time = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime();
    }
    return { kind: 'add', kwh: Math.round(kwh * 100) / 100, cost: Math.round(cost * 100) / 100, time };
}
