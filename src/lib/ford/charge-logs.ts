/*
 * Charge log of the official query API (GET /fcon-query/v1/fccs?startDate=&endDate=), read once a day.
 * Test stage (Sven 14.11.2026): it is not known yet whether public charging (Electroverse) shows up and
 * whether a price is included, so the answer is kept as it comes - minus everything that identifies the car
 * or a place (VIN, coordinates, address, names of saved places).
 */

/** Keys that are removed wherever they appear */
const PRIVATE_KEY =
    /^(vin|deviceid|vehicleid|latitude|longitude|lat|lon|lng|geohash|address|address1|address2|street|city|postalcode|zip|name|userid|email)$/i;

/** Hard limit for the state (the API keeps only some 20 entries anyway) */
export const MAX_LOG_CHARS = 60_000;

/**
 * Deep copy without private keys.
 *
 * @param value - Answer of the API
 * @param depth - Recursion guard
 */
export function sanitizeChargeLogs(value: unknown, depth = 0): unknown {
    if (depth > 8) {
        return null;
    }
    if (Array.isArray(value)) {
        return value.map(item => sanitizeChargeLogs(item, depth + 1));
    }
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            if (!PRIVATE_KEY.test(key)) {
                out[key] = sanitizeChargeLogs(item, depth + 1);
            }
        }
        return out;
    }
    return value;
}

/**
 * Number of log entries in an answer (first array found), for the status text.
 *
 * @param value - Sanitized answer
 */
export function countEntries(value: unknown): number {
    if (Array.isArray(value)) {
        return value.length;
    }
    if (value && typeof value === 'object') {
        for (const item of Object.values(value as Record<string, unknown>)) {
            if (Array.isArray(item)) {
                return item.length;
            }
        }
    }
    return 0;
}

/**
 * Local date "YYYY-MM-DD".
 *
 * @param t - Epoch ms
 */
export function isoDay(t: number): string {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Local hour of the daily read: night, far from restarts during the day */
export const CHARGE_LOG_HOUR = 4;

/**
 * True once per day: at the first poll after CHARGE_LOG_HOUR that comes after the last read (or the start).
 * Never right after a restart, so restarts do not keep a rate limit of Ford alive.
 *
 * @param lastAt - Last read or start of the service (epoch ms)
 * @param now - Current time (epoch ms)
 */
export function chargeLogDue(lastAt: number, now: number): boolean {
    const d = new Date(now);
    const slot = new Date(d.getFullYear(), d.getMonth(), d.getDate(), CHARGE_LOG_HOUR).getTime();
    const latest =
        now >= slot ? slot : new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, CHARGE_LOG_HOUR).getTime();
    return lastAt < latest;
}
