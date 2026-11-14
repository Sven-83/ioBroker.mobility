/*
 * Rates the current price against the last 7 days and finds the usually cheapest time.
 * All values are time-weighted: a price that held for 10 hours counts more than one that held
 * for 10 minutes. Hours and weekdays use the local time of the ioBroker host.
 */

import { WINDOW_MS, type PricePoint } from './price-history';

/** Rating of the current price */
export type PriceRating = 'cheap' | 'normal' | 'expensive' | 'unknown';

/** Share of the time below which a price counts as cheap (and above 1 - this as expensive) */
export const CHEAP_SHARE = 0.25;

/** Minimum observed time before a rating is given (less data says nothing about "usual") */
export const MIN_COVERAGE_MS = 24 * 3_600_000;

/** Minimum observed time before a weekday recommendation is given */
export const MIN_WEEKDAY_COVERAGE_MS = 6 * 24 * 3_600_000;

/** Result of the evaluation */
export interface PriceEvaluation {
    /** Rating of the current price */
    rating: PriceRating;
    /** Share of the time it was cheaper than now (0 = never cheaper), null without enough data */
    rank: number | null;
    /** Lowest / highest / time-weighted average price in the window, null without data */
    min: number | null;
    /** Highest price in the window */
    max: number | null;
    /** Time-weighted average price in the window */
    average: number | null;
    /** Observed time with a price in the window (ms) */
    coverageMs: number;
    /** Hour of day (0-23) with the lowest average price, null without enough data */
    bestHour: number | null;
    /** Average price in that hour */
    bestHourPrice: number | null;
    /** Weekday (0 = Sunday) with the lowest average price, null with less than 6 days of data */
    bestWeekday: number | null;
    /** Average price on that weekday */
    bestWeekdayPrice: number | null;
    /** Average price per hour of day (index 0-23), null for hours with less than 30 min data */
    hourProfile: (number | null)[];
}

/** Buckets (hour, weekday) with less data than this are left out */
const MIN_BUCKET_MS = 30 * 60_000;

/**
 * Change points for a chart of the 7-day window: the price valid at the window start is moved to the
 * start, later points stay as they are. Null = no price (closed).
 *
 * @param points - Change points (oldest first)
 * @param now - Current time (epoch ms)
 */
export function chartPoints(points: readonly PricePoint[], now: number): PricePoint[] {
    const start = now - WINDOW_MS;
    const out: PricePoint[] = [];
    for (let i = 0; i < points.length; i++) {
        const [time, price] = points[i];
        if (time > now) {
            break;
        }
        if (time < start) {
            const next = points[i + 1];
            if (!next || next[0] > start) {
                out.push([start, price]);
            }
            continue;
        }
        out.push([time, price]);
    }
    return out;
}

/** One price segment: price held from start to end */
interface Segment {
    start: number;
    end: number;
    price: number;
}

/**
 * Turns change points into segments inside [now - 7 days, now].
 *
 * @param points - Change points (oldest first)
 * @param now - Current time (epoch ms)
 */
export function segments(points: readonly PricePoint[], now: number): Segment[] {
    const windowStart = now - WINDOW_MS;
    const result: Segment[] = [];
    for (let i = 0; i < points.length; i++) {
        const [time, price] = points[i];
        if (price === null) {
            continue;
        }
        const start = Math.max(time, windowStart);
        const end = Math.min(i + 1 < points.length ? points[i + 1][0] : now, now);
        if (end > start) {
            result.push({ start, end, price });
        }
    }
    return result;
}

/**
 * Evaluates one series.
 *
 * @param points - Change points of the series
 * @param current - Current price (null = none)
 * @param now - Current time (epoch ms)
 */
export function evaluate(points: readonly PricePoint[], current: number | null, now: number): PriceEvaluation {
    const parts = segments(points, now);
    const coverageMs = parts.reduce((sum, part) => sum + (part.end - part.start), 0);
    const result: PriceEvaluation = {
        rating: 'unknown',
        rank: null,
        min: null,
        max: null,
        average: null,
        coverageMs,
        bestHour: null,
        bestHourPrice: null,
        bestWeekday: null,
        bestWeekdayPrice: null,
        hourProfile: Array.from({ length: 24 }, () => null),
    };
    if (coverageMs === 0) {
        return result;
    }

    result.min = Math.min(...parts.map(part => part.price));
    result.max = Math.max(...parts.map(part => part.price));
    result.average = round3(parts.reduce((sum, part) => sum + part.price * (part.end - part.start), 0) / coverageMs);

    if (coverageMs < MIN_COVERAGE_MS) {
        return result;
    }

    if (current !== null) {
        // cheap: it was cheaper only rarely (< 25 % of the time) and the price is below average;
        // expensive: mirrored. The average check keeps a price that never changed "normal".
        let below = 0;
        let above = 0;
        for (const part of parts) {
            const duration = part.end - part.start;
            if (part.price < current) {
                below += duration;
            } else if (part.price > current) {
                above += duration;
            }
        }
        const average = result.average;
        result.rank = Math.round((below / coverageMs) * 100) / 100;
        if (below / coverageMs < CHEAP_SHARE && current < average) {
            result.rating = 'cheap';
        } else if (above / coverageMs < CHEAP_SHARE && current > average) {
            result.rating = 'expensive';
        } else {
            result.rating = 'normal';
        }
    }

    const hours = averagesBy(
        parts,
        24,
        date => date.getHours(),
        date => nextHour(date),
    );
    result.hourProfile = hours.map(entry =>
        entry.duration < MIN_BUCKET_MS ? null : round3(entry.weighted / entry.duration),
    );
    const bestHour = cheapest(hours);
    if (bestHour) {
        result.bestHour = bestHour.index;
        result.bestHourPrice = bestHour.average;
    }

    if (coverageMs >= MIN_WEEKDAY_COVERAGE_MS) {
        const days = averagesBy(
            parts,
            7,
            date => date.getDay(),
            date => nextDay(date),
        );
        const bestDay = cheapest(days);
        if (bestDay) {
            result.bestWeekday = bestDay.index;
            result.bestWeekdayPrice = bestDay.average;
        }
    }
    return result;
}

/**
 * Time-weighted sums per bucket (hour of day or weekday), splitting segments at bucket borders.
 *
 * @param parts - Segments
 * @param size - Number of buckets
 * @param bucket - Bucket of a point in time
 * @param next - Start of the next bucket after a point in time
 */
function averagesBy(
    parts: Segment[],
    size: number,
    bucket: (date: Date) => number,
    next: (date: Date) => number,
): { weighted: number; duration: number }[] {
    const sums = Array.from({ length: size }, () => ({ weighted: 0, duration: 0 }));
    for (const part of parts) {
        let start = part.start;
        while (start < part.end) {
            const date = new Date(start);
            // the guard keeps the loop moving even on odd DST transitions
            const end = Math.min(Math.max(next(date), start + 60_000), part.end);
            const entry = sums[bucket(date)];
            entry.weighted += part.price * (end - start);
            entry.duration += end - start;
            start = end;
        }
    }
    return sums;
}

/**
 * Bucket with the lowest average; buckets with less than 30 min data are ignored.
 *
 * @param sums - Result of averagesBy
 */
function cheapest(sums: { weighted: number; duration: number }[]): { index: number; average: number } | undefined {
    let best: { index: number; average: number } | undefined;
    sums.forEach((entry, index) => {
        if (entry.duration < MIN_BUCKET_MS) {
            return;
        }
        const average = entry.weighted / entry.duration;
        if (!best || average < best.average) {
            best = { index, average };
        }
    });
    return best ? { index: best.index, average: round3(best.average) } : undefined;
}

/**
 * @param date - Point in time
 */
function nextHour(date: Date): number {
    const next = new Date(date);
    next.setMinutes(0, 0, 0);
    next.setHours(next.getHours() + 1);
    return next.getTime();
}

/**
 * @param date - Point in time
 */
function nextDay(date: Date): number {
    const next = new Date(date);
    next.setHours(0, 0, 0, 0);
    next.setDate(next.getDate() + 1);
    return next.getTime();
}

/**
 * @param value - Price
 */
function round3(value: number): number {
    return Math.round(value * 1000) / 1000;
}
