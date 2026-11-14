/*
 * Per-vehicle history for the dashboard (stored as a file in the adapter's file storage).
 *
 * Every poll adds one sample. From the samples the history keeps:
 *  - raw samples of the last 8 days (tyre trend),
 *  - one record per local day for about 13 months (km, long trips, energy, fuel, temperature),
 *  - the last refuels (Δ fuel level ≥ 10 %).
 * Weeks and months are summed from the day records when the states are written.
 *
 * Trips: polls with a rising odometer belong to one trip; the trip ends at the first poll without
 * movement. A trip longer than LONG_TRIP_KM counts as long-distance (with 30-min polling two trips
 * close together can merge - good enough for a weekly share).
 */

import { dayKey, lastMonthKeys, lastWeekKeys, weekKey, lastDayKeys } from '../util/periods';

export { dayKey, weekKey };

/** Wheels as used in VehicleState.tires */
export type Tyres = Record<string, number>;

/** One poll of one vehicle; null = not delivered */
export interface HistorySample {
    /** Time of the vehicle data (epoch ms) */
    t: number;
    /** Odometer in km */
    odo: number | null;
    /** Outside temperature in °C */
    temp: number | null;
    /** Fuel level in % (not for BEV) */
    fuel: number | null;
    /** Energy in the high-voltage battery in kWh */
    energy: number | null;
    /** Tyre pressure per wheel in kPa */
    tyres: Tyres;
}

interface DayRecord {
    /** Local date YYYY-MM-DD */
    d: string;
    km: number;
    longKm: number;
    /** kWh used while driving and the km they belong to */
    kwhUsed: number;
    kmEv: number;
    /** kWh added to the battery (charging) */
    kwhCharged: number;
    /** Fuel level added (percent points) */
    fuelPct: number;
    tempSum: number;
    tempN: number;
}

interface Refuel {
    t: number;
    pct: number;
    odo: number | null;
}

interface Trip {
    km: number;
    /** km per day of this trip */
    parts: Record<string, number>;
}

/** Summary of a week or month for the dashboard */
export interface PeriodSummary {
    /** "2026-W46" or "2026-11" */
    period: string;
    /** km driven */
    km: number;
    /** km of trips over LONG_TRIP_KM */
    longKm: number;
    /** kWh per 100 km while driving (BEV), null without data */
    kwhPer100: number | null;
    /** kWh used while driving */
    kwhUsed: number;
    /** km driven with energy data (basis of kwhPer100) */
    kmEv: number;
    /** kWh charged */
    kwhCharged: number;
    /** Litres filled (needs the tank size), null if unknown */
    litres: number | null;
    /** Fuel level added in percent points */
    fuelPct: number;
    /** Average outside temperature, null without data */
    temp: number | null;
}

export const LONG_TRIP_KM = 50;
export const SAMPLE_DAYS = 8;
export const DAY_RECORDS = 400;
export const MAX_REFUELS = 30;
/** Fuel level jump that counts as refuel (percent points) */
export const REFUEL_PCT = 10;
/** Battery energy gain that counts as charging (kWh, noise filter) */
export const CHARGE_KWH = 0.3;
/** Tyre trend needs samples spread over at least this many days */
export const TYRE_TREND_MIN_DAYS = 3;
const DAY = 86_400_000;
const VERSION = 1;

/**
 * Tyre pressure (gauge, kPa) converted to 20 °C, so a cold night is not taken for a leak.
 *
 * @param kpa - Gauge pressure
 * @param tempC - Outside temperature
 */
export function normaliseTyre(kpa: number, tempC: number): number {
    return (kpa + 101.3) * (293.15 / (tempC + 273.15)) - 101.3;
}

/**
 * @param values - Numbers
 */
function median(values: number[]): number {
    const s = [...values].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * @param n - Number
 * @param digits - Decimals
 */
function round(n: number, digits = 1): number {
    const f = 10 ** digits;
    return Math.round(n * f) / f;
}

/**
 * History of one vehicle.
 */
export class VehicleHistory {
    private samples: HistorySample[] = [];
    private days = new Map<string, DayRecord>();
    private refuels: Refuel[] = [];
    private trip: Trip | null = null;

    /**
     * Restores a stored history; invalid text gives an empty history.
     *
     * @param text - Stored JSON or undefined
     */
    public static parse(text: string | undefined): { history: VehicleHistory; ok: boolean } {
        const history = new VehicleHistory();
        if (!text) {
            return { history, ok: true };
        }
        try {
            const data = JSON.parse(text) as {
                version?: number;
                samples?: HistorySample[];
                days?: DayRecord[];
                refuels?: Refuel[];
                trip?: Trip | null;
            };
            if (data.version !== VERSION) {
                return { history, ok: false };
            }
            history.samples = Array.isArray(data.samples) ? data.samples.filter(s => typeof s?.t === 'number') : [];
            for (const day of Array.isArray(data.days) ? data.days : []) {
                if (typeof day?.d === 'string') {
                    history.days.set(day.d, day);
                }
            }
            history.refuels = Array.isArray(data.refuels) ? data.refuels.filter(r => typeof r?.t === 'number') : [];
            history.trip = data.trip && typeof data.trip.km === 'number' ? data.trip : null;
            return { history, ok: true };
        } catch {
            return { history, ok: false };
        }
    }

    /** JSON for the file */
    public serialize(): string {
        return JSON.stringify({
            version: VERSION,
            samples: this.samples,
            days: [...this.days.values()],
            refuels: this.refuels,
            trip: this.trip,
        });
    }

    /**
     * Adds one poll. Samples with the same vehicle time as the last one are ignored
     * (the vehicle did not report anything new).
     *
     * @param s - Sample
     */
    public add(s: HistorySample): void {
        const prev = this.samples[this.samples.length - 1];
        if (prev && s.t <= prev.t) {
            return;
        }
        const day = this.day(dayKey(s.t));
        if (s.temp !== null) {
            day.tempSum += s.temp;
            day.tempN++;
        }
        if (prev) {
            const dOdo = s.odo !== null && prev.odo !== null ? s.odo - prev.odo : 0;
            const moved = dOdo > 0 && dOdo < 2000;
            if (moved) {
                day.km += dOdo;
                this.trip ??= { km: 0, parts: {} };
                this.trip.km += dOdo;
                this.trip.parts[day.d] = (this.trip.parts[day.d] ?? 0) + dOdo;
            } else {
                this.closeTrip();
            }
            if (s.energy !== null && prev.energy !== null) {
                const dE = s.energy - prev.energy;
                if (moved && dE < 0) {
                    day.kwhUsed += -dE;
                    day.kmEv += dOdo;
                } else if (dE >= CHARGE_KWH) {
                    day.kwhCharged += dE;
                }
            }
            if (s.fuel !== null && prev.fuel !== null && s.fuel - prev.fuel >= REFUEL_PCT) {
                const pct = s.fuel - prev.fuel;
                day.fuelPct += pct;
                this.refuels.push({ t: s.t, pct: round(pct), odo: s.odo });
                this.refuels.splice(0, Math.max(0, this.refuels.length - MAX_REFUELS));
            }
        }
        this.samples.push(s);
        this.prune(s.t);
    }

    /**
     * Pressure loss over the last 7 days per wheel in kPa (temperature-corrected),
     * only wheels that lost pressure; empty while there is too little data.
     *
     * @param now - Current time
     */
    public tyreLoss(now: number): Record<string, number> {
        const window = this.samples.filter(s => s.t >= now - 7 * DAY && s.temp !== null);
        if (window.length < 2 || window[window.length - 1].t - window[0].t < TYRE_TREND_MIN_DAYS * DAY) {
            return {};
        }
        const first = window[0].t;
        const last = window[window.length - 1].t;
        const result: Record<string, number> = {};
        const wheels = new Set(window.flatMap(s => Object.keys(s.tyres)));
        for (const wheel of wheels) {
            const values = (from: number, to: number): number[] =>
                window
                    .filter(s => s.t >= from && s.t <= to && typeof s.tyres[wheel] === 'number')
                    .map(s => normaliseTyre(s.tyres[wheel], s.temp as number));
            const before = values(first, first + DAY);
            const after = values(last - DAY, last);
            if (before.length && after.length) {
                const loss = median(before) - median(after);
                if (loss > 0) {
                    result[wheel] = round(loss);
                }
            }
        }
        return result;
    }

    /**
     * Last weeks (oldest first, current week included).
     *
     * @param now - Current time
     * @param count - Number of weeks
     * @param tankLitres - Tank size (0 = unknown)
     */
    public weeks(now: number, count: number, tankLitres: number): PeriodSummary[] {
        return lastWeekKeys(now, count).map(key => this.summary(key, d => weekKey(d) === key, tankLitres));
    }

    /**
     * Last days (oldest first, today included).
     *
     * @param now - Current time
     * @param count - Number of days
     * @param tankLitres - Tank size (0 = unknown)
     */
    public dailies(now: number, count: number, tankLitres: number): PeriodSummary[] {
        return lastDayKeys(now, count).map(key => this.summary(key, d => d === key, tankLitres));
    }

    /**
     * Last months (oldest first, current month included).
     *
     * @param now - Current time
     * @param count - Number of months
     * @param tankLitres - Tank size (0 = unknown)
     */
    public months(now: number, count: number, tankLitres: number): PeriodSummary[] {
        return lastMonthKeys(now, count).map(key => this.summary(key, d => d.startsWith(key), tankLitres));
    }

    /**
     * Fuel consumption from the last refuels in l/100 km (needs tank size and odometer), null if unknown.
     *
     * @param tankLitres - Tank size
     */
    public fuelConsumption(tankLitres: number): number | null {
        if (tankLitres <= 0) {
            return null;
        }
        let litres = 0;
        let km = 0;
        const list = this.refuels.slice(-6);
        for (let i = 1; i < list.length; i++) {
            const a = list[i - 1].odo;
            const b = list[i].odo;
            if (a !== null && b !== null && b > a) {
                litres += (list[i].pct / 100) * tankLitres;
                km += b - a;
            }
        }
        return km >= 100 ? round((litres / km) * 100) : null;
    }

    /** Last refuel or null */
    public lastRefuel(): Refuel | null {
        return this.refuels[this.refuels.length - 1] ?? null;
    }

    /**
     * @param period - Key
     * @param match - Day filter
     * @param tankLitres - Tank size
     */
    private summary(period: string, match: (d: string) => boolean, tankLitres: number): PeriodSummary {
        const sum = { km: 0, longKm: 0, kwhUsed: 0, kmEv: 0, kwhCharged: 0, fuelPct: 0, tempSum: 0, tempN: 0 };
        for (const day of this.days.values()) {
            if (match(day.d)) {
                for (const key of Object.keys(sum) as (keyof typeof sum)[]) {
                    sum[key] += day[key];
                }
            }
        }
        return {
            period,
            km: Math.round(sum.km),
            longKm: Math.round(sum.longKm),
            kwhPer100: sum.kmEv >= 20 ? round((sum.kwhUsed / sum.kmEv) * 100) : null,
            kwhUsed: round(sum.kwhUsed),
            kmEv: Math.round(sum.kmEv),
            kwhCharged: round(sum.kwhCharged),
            litres: tankLitres > 0 ? round((sum.fuelPct / 100) * tankLitres) : null,
            fuelPct: round(sum.fuelPct),
            temp: sum.tempN ? round(sum.tempSum / sum.tempN) : null,
        };
    }

    /** Ends the running trip and books long-distance km */
    private closeTrip(): void {
        if (this.trip && this.trip.km > LONG_TRIP_KM) {
            for (const [d, km] of Object.entries(this.trip.parts)) {
                this.day(d).longKm += km;
            }
        }
        this.trip = null;
    }

    /**
     * @param d - Day key
     */
    private day(d: string): DayRecord {
        let rec = this.days.get(d);
        if (!rec) {
            rec = { d, km: 0, longKm: 0, kwhUsed: 0, kmEv: 0, kwhCharged: 0, fuelPct: 0, tempSum: 0, tempN: 0 };
            this.days.set(d, rec);
        }
        return rec;
    }

    /**
     * @param now - Time of the newest sample
     */
    private prune(now: number): void {
        this.samples = this.samples.filter(s => s.t >= now - SAMPLE_DAYS * DAY);
        if (this.days.size > DAY_RECORDS) {
            const keys = [...this.days.keys()].sort();
            for (const key of keys.slice(0, keys.length - DAY_RECORDS)) {
                this.days.delete(key);
            }
        }
    }
}
