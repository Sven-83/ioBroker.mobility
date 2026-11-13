/*
 * Vehicle warnings for the dashboard: one list per vehicle, worst first.
 *
 * Levels: "critical" (act now, red), "warning" (soon, yellow), "info" (grey).
 * The adapter only delivers key, level and the value behind it; the widget turns the key into a
 * localised text and an icon. Thresholds as agreed for the dashboard (13.11.2026).
 */

import { BATTERY_12V_LOW_PERCENT, BATTERY_12V_LOW_VOLT, isBev, type VehicleState } from './telemetry';

export type WarningLevel = 'critical' | 'warning' | 'info';

/** One warning; value/unit/wheel only where they help the text ("tyre front left 1.6 bar") */
export interface VehicleWarning {
    /** What is wrong (the widget maps it to text and icon) */
    key: WarningKey;
    /** How urgent */
    level: WarningLevel;
    /** Measured value behind the warning */
    value?: number;
    /** Unit of value */
    unit?: string;
    /** Wheel for tyre warnings (frontLeft, ...) */
    wheel?: string;
}

export type WarningKey =
    | 'alarm'
    | 'unlocked'
    | 'window'
    | 'door'
    | 'tyre'
    | 'chargeFault'
    | 'fuel'
    | 'battery'
    | 'battery12v'
    | 'oil'
    | 'notPluggedIn'
    | 'batteryPerformance'
    | 'tyreLoss'
    | 'frost'
    | 'stale'
    | 'login';

/** Thresholds (percent unless stated otherwise) */
export const LIMITS = {
    /** Unlocked with ignition off for longer than this counts */
    unlockedMs: 10 * 60_000,
    /** Tyre below this share of the placard pressure */
    tyreShare: 0.85,
    fuelWarn: 25,
    fuelCritical: 10,
    socWarn: 20,
    socCritical: 10,
    battery12vCritical: 25,
    oilWarn: 15,
    oilCritical: 5,
    /** "Not plugged in" from this hour on ... */
    plugHour: 20,
    /** ... when the battery is below this */
    plugSoc: 50,
    frostC: 3,
    staleMs: 12 * 3_600_000,
    loginMs: 14 * 24 * 3_600_000,
} as const;

/** Everything besides the telemetry the rules need */
export interface WarningContext {
    /** Current time (epoch ms) */
    now: number;
    /** Since when the vehicle is known to be unlocked (epoch ms), null if locked or unknown */
    unlockedSince: number | null;
    /** When the browser login expires (epoch ms), null if unknown */
    loginExpires: number | null;
    /** Local hour 0-23 (for "not plugged in in the evening") */
    hour: number;
    /** Tyre pressure loss over 7 days in kPa per wheel (later, phase 2) */
    tyreLoss?: Record<string, number>;
}

const ORDER: Record<WarningLevel, number> = { critical: 0, warning: 1, info: 2 };
/** Order within a level: more important first */
const KEY_ORDER: WarningKey[] = [
    'alarm',
    'tyre',
    'unlocked',
    'door',
    'window',
    'chargeFault',
    'fuel',
    'battery',
    'battery12v',
    'oil',
    'tyreLoss',
    'notPluggedIn',
    'batteryPerformance',
    'frost',
    'stale',
    'login',
];

/** Charge display states that mean the charging stopped with a problem */
const CHARGE_FAULT = /FAULT|ERROR|ABORT|INTERRUPT|FAIL/;

/**
 * Computes the warnings of one vehicle.
 *
 * @param st - Parsed telemetry
 * @param ctx - Time and remembered facts
 */
export function computeWarnings(st: VehicleState, ctx: WarningContext): VehicleWarning[] {
    const list: VehicleWarning[] = [];
    const add = (w: VehicleWarning): void => {
        list.push(w);
    };
    const parked = st.ignition === null || st.ignition.toUpperCase() === 'OFF';

    // red
    if (st.alarmTriggered) {
        add({ key: 'alarm', level: 'critical' });
    }
    for (const [wheel, pressure] of Object.entries(st.tires)) {
        const status = st.tireStatus[wheel];
        const placard = st.tirePlacard[wheel];
        const low =
            (status !== undefined && status !== 'NORMAL') ||
            (placard !== undefined && pressure < placard * LIMITS.tyreShare);
        if (low) {
            add({ key: 'tyre', level: 'critical', wheel, value: Math.round(pressure) / 100, unit: 'bar' });
        }
    }
    if (
        parked &&
        st.locked === false &&
        ctx.unlockedSince !== null &&
        ctx.now - ctx.unlockedSince >= LIMITS.unlockedMs
    ) {
        add({ key: 'unlocked', level: 'critical' });
    }
    if (parked && (st.doorsClosed === false || st.hoodClosed === false)) {
        add({ key: 'door', level: 'critical' });
    }
    if (parked && st.windowsClosed === false) {
        add({ key: 'window', level: 'critical' });
    }
    if (st.chargeStatus && CHARGE_FAULT.test(st.chargeStatus.toUpperCase())) {
        add({ key: 'chargeFault', level: 'critical' });
    }

    // levels with two steps
    const bev = isBev(st);
    if (!bev && st.fuelLevel !== null && st.fuelLevel <= LIMITS.fuelWarn) {
        add({
            key: 'fuel',
            level: st.fuelLevel <= LIMITS.fuelCritical ? 'critical' : 'warning',
            value: st.fuelLevel,
            unit: '%',
        });
    }
    if (bev && st.soc !== null && st.soc <= LIMITS.socWarn) {
        add({ key: 'battery', level: st.soc <= LIMITS.socCritical ? 'critical' : 'warning', value: st.soc, unit: '%' });
    }
    if (st.battery12v !== null) {
        if (st.battery12v < BATTERY_12V_LOW_PERCENT) {
            add({
                key: 'battery12v',
                level: st.battery12v < LIMITS.battery12vCritical ? 'critical' : 'warning',
                value: st.battery12v,
                unit: '%',
            });
        }
    } else if (parked && st.battery12vVoltage !== null && st.battery12vVoltage < BATTERY_12V_LOW_VOLT) {
        add({ key: 'battery12v', level: 'warning', value: st.battery12vVoltage, unit: 'V' });
    }
    if (st.oilLife !== null && st.oilLife <= LIMITS.oilWarn) {
        add({
            key: 'oil',
            level: st.oilLife <= LIMITS.oilCritical ? 'critical' : 'warning',
            value: st.oilLife,
            unit: '%',
        });
    }

    // yellow
    for (const [wheel, loss] of Object.entries(ctx.tyreLoss ?? {})) {
        if (loss >= 20 && !list.some(w => w.key === 'tyre' && w.wheel === wheel)) {
            add({ key: 'tyreLoss', level: 'warning', wheel, value: Math.round(loss) / 100, unit: 'bar' });
        }
    }
    if (
        bev &&
        ctx.hour >= LIMITS.plugHour &&
        st.soc !== null &&
        st.soc < LIMITS.plugSoc &&
        st.plugStatus?.toUpperCase() === 'DISCONNECTED'
    ) {
        add({ key: 'notPluggedIn', level: 'warning', value: st.soc, unit: '%' });
    }
    if (st.batteryPerformance !== null && st.batteryPerformance !== 'NORMAL') {
        add({ key: 'batteryPerformance', level: 'warning' });
    }

    // grey
    if (st.outsideTemp !== null && st.outsideTemp <= LIMITS.frostC) {
        add({ key: 'frost', level: 'info', value: st.outsideTemp, unit: '°C' });
    }
    if (st.updateTime !== null && ctx.now - st.updateTime > LIMITS.staleMs) {
        add({ key: 'stale', level: 'info', value: Math.floor((ctx.now - st.updateTime) / 3_600_000), unit: 'h' });
    }
    if (ctx.loginExpires !== null && ctx.loginExpires - ctx.now < LIMITS.loginMs) {
        add({
            key: 'login',
            level: 'info',
            value: Math.max(0, Math.ceil((ctx.loginExpires - ctx.now) / 86_400_000)),
            unit: 'd',
        });
    }

    return list.sort((a, b) => ORDER[a.level] - ORDER[b.level] || KEY_ORDER.indexOf(a.key) - KEY_ORDER.indexOf(b.key));
}

/**
 * Highest level of a list, "none" if empty.
 *
 * @param list - Warnings
 */
export function worstLevel(list: VehicleWarning[]): WarningLevel | 'none' {
    return list[0]?.level ?? 'none';
}
