/*
 * Local day, ISO week and month keys shared by the history parts (Ford, Easee).
 * "Local" = time zone of the ioBroker host.
 */

const DAY = 86_400_000;

/**
 * Local date key.
 *
 * @param t - Epoch ms
 */
export function dayKey(t: number): string {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * ISO week key of a local date key, e.g. "2026-W46".
 *
 * @param d - YYYY-MM-DD
 */
export function weekKey(d: string): string {
    const [y, m, day] = d.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, day));
    const weekday = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - weekday);
    const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
    const week = Math.ceil(((date.getTime() - yearStart) / DAY + 1) / 7);
    return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Keys of the last weeks, oldest first, current week included.
 *
 * @param now - Current time
 * @param count - Number of weeks
 */
export function lastWeekKeys(now: number, count: number): string[] {
    const keys: string[] = [];
    for (let i = count - 1; i >= 0; i--) {
        const key = weekKey(dayKey(now - i * 7 * DAY));
        if (!keys.includes(key)) {
            keys.push(key);
        }
    }
    return keys;
}

/**
 * Keys of the last months ("2026-11"), oldest first, current month included.
 *
 * @param now - Current time
 * @param count - Number of months
 */
export function lastMonthKeys(now: number, count: number): string[] {
    const date = new Date(now);
    const keys: string[] = [];
    for (let i = count - 1; i >= 0; i--) {
        const m = new Date(date.getFullYear(), date.getMonth() - i, 1);
        keys.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`);
    }
    return keys;
}
