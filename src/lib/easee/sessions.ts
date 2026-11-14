/*
 * Charging sessions of one Easee charger and their evaluation (kWh and EUR per week / month).
 *
 * Source: GET /api/sessions/charger/{serial}/sessions/{from}/{to} (checked with the real account
 * 2026-11-14: 400 days in one request, ~0.2 s; one session = plug in .. unplug):
 *   { id, carConnected, carDisconnected, kiloWattHours, actualDurationSeconds,
 *     firstEnergyTransferPeriodStarted, lastEnergyTransferPeriodEnd, isComplete,
 *     pricePrKwhIncludingVat, costIncludingVat, ..., chargerId, authToken, authUser }
 * Only the fields below are kept; charger ID, RFID token and user are dropped right here.
 *
 * Costs: Easee's own cost if it is set (> 0), otherwise kWh x configured price. A session is
 * booked on the local day it started (like the Easee app).
 * Sessions are never removed from the store (owner's rule: nothing Easee is ever deleted).
 */

import { dayKey, lastMonthKeys, lastWeekKeys, weekKey, lastDayKeys } from '../util/periods';

/** One charging session */
export interface ChargeSession {
    /** Easee session ID (only used to merge downloads) */
    id: number;
    /** Car plugged in (epoch ms) */
    start: number;
    /** Car unplugged (epoch ms), null while running */
    end: number | null;
    /** Energy in kWh */
    kwh: number;
    /** Time with energy flow in s, null if unknown */
    seconds: number | null;
    /** Cost from Easee incl. VAT, null if Easee has no price */
    easeeCost: number | null;
    /** Session finished */
    complete: boolean;
}

/** Sum of a week, month or year */
export interface SessionSummary {
    /** "2026-W46", "2026-11" or "2026" */
    period: string;
    /** Number of sessions */
    sessions: number;
    /** kWh */
    kwh: number;
    /** EUR, null without price */
    cost: number | null;
}

/** Last session for the dashboard */
export interface LastSession {
    /** Plugged in (epoch ms) */
    start: number;
    /** Unplugged (epoch ms), null while running */
    end: number | null;
    /** Energy in kWh */
    kwh: number;
    /** EUR, null without price */
    cost: number | null;
    /** Minutes with energy flow, null if unknown */
    minutes: number | null;
}

const VERSION = 1;

/**
 * @param n - Number
 * @param digits - Decimals
 */
function round(n: number, digits: number): number {
    const f = 10 ** digits;
    return Math.round(n * f) / f;
}

/**
 * @param value - ISO time or anything
 */
function time(value: unknown): number | null {
    if (typeof value !== 'string' || value === '') {
        return null;
    }
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
}

/**
 * @param value - Number or numeric string
 */
function num(value: unknown): number | null {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Parses the answer of the sessions endpoint; invalid entries are skipped.
 *
 * @param body - JSON answer
 * @returns Sessions, or undefined if the answer is no list
 */
export function parseSessions(body: unknown): ChargeSession[] | undefined {
    if (!Array.isArray(body)) {
        return undefined;
    }
    const result: ChargeSession[] = [];
    for (const entry of body) {
        const raw = (entry ?? {}) as Record<string, unknown>;
        const id = num(raw.id);
        const start = time(raw.carConnected) ?? time(raw.firstEnergyTransferPeriodStarted);
        const kwh = num(raw.kiloWattHours);
        if (id === null || start === null || kwh === null || kwh < 0 || kwh > 1_000) {
            continue;
        }
        const cost = num(raw.costIncludingVat);
        const seconds = num(raw.actualDurationSeconds);
        result.push({
            id,
            start,
            end: time(raw.carDisconnected),
            kwh: round(kwh, 3),
            seconds: seconds !== null && seconds >= 0 ? Math.round(seconds) : null,
            easeeCost: cost !== null && cost > 0 ? round(cost, 2) : null,
            complete: raw.isComplete === true,
        });
    }
    return result;
}

/**
 * All known sessions of one charger.
 */
export class SessionStore {
    private readonly byId = new Map<number, ChargeSession>();
    /** Downloads reached back to this time (epoch ms), null = not started */
    public backfilledTo: number | null = null;
    /** No older sessions exist */
    public backfillDone = false;

    /**
     * @param text - Stored JSON, undefined = empty store
     */
    public static parse(text: string | undefined): SessionStore {
        const store = new SessionStore();
        if (!text) {
            return store;
        }
        try {
            const data = JSON.parse(text) as {
                v?: number;
                sessions?: unknown;
                backfilledTo?: unknown;
                backfillDone?: unknown;
            };
            if (data.v !== VERSION || !Array.isArray(data.sessions)) {
                return store;
            }
            for (const s of data.sessions as Partial<ChargeSession>[]) {
                if (typeof s?.id === 'number' && typeof s.start === 'number' && typeof s.kwh === 'number') {
                    store.byId.set(s.id, {
                        id: s.id,
                        start: s.start,
                        end: typeof s.end === 'number' ? s.end : null,
                        kwh: s.kwh,
                        seconds: typeof s.seconds === 'number' ? s.seconds : null,
                        easeeCost: typeof s.easeeCost === 'number' ? s.easeeCost : null,
                        complete: s.complete === true,
                    });
                }
            }
            store.backfilledTo = typeof data.backfilledTo === 'number' ? data.backfilledTo : null;
            store.backfillDone = data.backfillDone === true;
        } catch {
            // broken file: start again (sessions are downloaded again)
        }
        return store;
    }

    /** JSON for the file */
    public serialize(): string {
        return JSON.stringify({
            v: VERSION,
            backfilledTo: this.backfilledTo,
            backfillDone: this.backfillDone,
            sessions: this.list(),
        });
    }

    /**
     * Adds or updates sessions (same ID = newer download wins).
     *
     * @param sessions - Downloaded sessions
     * @returns Number of new or changed sessions
     */
    public add(sessions: ChargeSession[]): number {
        let changed = 0;
        for (const s of sessions) {
            const old = this.byId.get(s.id);
            if (!old || JSON.stringify(old) !== JSON.stringify(s)) {
                this.byId.set(s.id, s);
                changed++;
            }
        }
        return changed;
    }

    /** Sessions sorted by start, oldest first */
    public list(): ChargeSession[] {
        return [...this.byId.values()].sort((a, b) => a.start - b.start);
    }

    /** Number of sessions */
    public get size(): number {
        return this.byId.size;
    }
}

/**
 * Cost of one session.
 *
 * @param s - Session
 * @param pricePerKwh - Configured price, 0 = none
 */
export function sessionCost(s: ChargeSession, pricePerKwh: number): number | null {
    if (s.easeeCost !== null) {
        return s.easeeCost;
    }
    return pricePerKwh > 0 ? round(s.kwh * pricePerKwh, 2) : null;
}

/**
 * Evaluation of the sessions of one or more chargers.
 */
export class SessionReport {
    private readonly sessions: ChargeSession[];

    /**
     * @param sessions - Sessions (any order, several chargers allowed)
     * @param pricePerKwh - Configured price, 0 = none
     */
    public constructor(
        sessions: ChargeSession[],
        private readonly pricePerKwh: number,
    ) {
        this.sessions = [...sessions].sort((a, b) => a.start - b.start);
    }

    /**
     * Last weeks, oldest first, current week included.
     *
     * @param now - Current time
     * @param count - Number of weeks
     */
    public weeks(now: number, count: number): SessionSummary[] {
        return lastWeekKeys(now, count).map(key => this.sum(key, s => weekKey(dayKey(s.start)) === key));
    }

    /**
     * Last days, oldest first, today included.
     *
     * @param now - Current time
     * @param count - Number of days
     */
    public days(now: number, count: number): SessionSummary[] {
        return lastDayKeys(now, count).map(key => this.sum(key, s => dayKey(s.start) === key));
    }

    /**
     * Last months, oldest first, current month included.
     *
     * @param now - Current time
     * @param count - Number of months
     */
    public months(now: number, count: number): SessionSummary[] {
        return lastMonthKeys(now, count).map(key => this.sum(key, s => dayKey(s.start).startsWith(key)));
    }

    /**
     * One calendar year.
     *
     * @param year - e.g. 2026
     */
    public year(year: number): SessionSummary {
        const key = String(year);
        return this.sum(key, s => dayKey(s.start).startsWith(`${key}-`));
    }

    /** Newest session or null */
    public last(): LastSession | null {
        const s = this.sessions[this.sessions.length - 1];
        if (!s) {
            return null;
        }
        return {
            start: s.start,
            end: s.end,
            kwh: round(s.kwh, 2),
            cost: sessionCost(s, this.pricePerKwh),
            minutes: s.seconds === null ? null : Math.round(s.seconds / 60),
        };
    }

    /** Start of the oldest session or null */
    public oldest(): number | null {
        return this.sessions[0]?.start ?? null;
    }

    /**
     * @param period - Key
     * @param match - Filter
     */
    private sum(period: string, match: (s: ChargeSession) => boolean): SessionSummary {
        let sessions = 0;
        let kwh = 0;
        let cost = 0;
        let priced = true;
        for (const s of this.sessions) {
            if (!match(s)) {
                continue;
            }
            sessions++;
            kwh += s.kwh;
            const c = sessionCost(s, this.pricePerKwh);
            if (c === null) {
                priced = false;
            } else {
                cost += c;
            }
        }
        return {
            period,
            sessions,
            kwh: round(kwh, 1),
            cost: priced && (sessions > 0 || this.pricePerKwh > 0) ? round(cost, 2) : null,
        };
    }
}
