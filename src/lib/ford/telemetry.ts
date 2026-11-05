/*
 * Parses /fcon-query/v1/telemetry. Format (reference ha-fordconnect-query):
 *   { updateTime: "...", metrics: { <key>: { value, updateTime, ... } | [ { value, vehicleWheel|vehicleDoor, ... } ] } }
 * Which metrics a vehicle delivers differs by model (newer models deliver more) - so the list of
 * available keys and a cleaned copy of the raw answer are kept to map more later.
 *
 * Data minimisation (ISO/IEC 27402, project rule): VIN, position and similar are removed from
 * everything that is stored or logged.
 */

/** Keys removed from the stored raw answer (case-insensitive, anywhere in the tree) */
const PRIVATE_KEY = /vin|position|latitude|longitude|location|gps|heading|address|plate|licen[cs]e|compass/i;

/** Tyre positions as delivered in tirePressure[].vehicleWheel */
export const WHEELS: Record<string, string> = {
    FRONT_LEFT: 'frontLeft',
    FRONT_RIGHT: 'frontRight',
    REAR_LEFT: 'rearLeft',
    REAR_RIGHT: 'rearRight',
};

/** Parsed vehicle state; null = not delivered */
export interface VehicleState {
    /** Time of the vehicle data (epoch ms) */
    updateTime: number | null;
    /** Fuel level in % */
    fuelLevel: number | null;
    /** Fuel range in km */
    fuelRange: number | null;
    /** High-voltage battery in % */
    soc: number | null;
    /** Electric range in km */
    evRange: number | null;
    /** Plug status text, e.g. CONNECTED */
    plugStatus: string | null;
    /** Charge status text, e.g. IN_PROGRESS */
    chargeStatus: string | null;
    /** Minutes until full */
    timeToFull: number | null;
    /** Odometer in km */
    odometer: number | null;
    /** 12 V battery in % */
    battery12v: number | null;
    /** 12 V battery voltage */
    battery12vVoltage: number | null;
    /** Oil life in % */
    oilLife: number | null;
    /** Outside temperature in °C */
    outsideTemp: number | null;
    /** Coolant temperature in °C */
    coolantTemp: number | null;
    /** Ignition text, e.g. OFF */
    ignition: string | null;
    /** Alarm text, e.g. ARMED */
    alarm: string | null;
    /** Tyre pressure per wheel (key from WHEELS) in kPa */
    tires: Record<string, number>;
    /** All doors closed, null if unknown */
    doorsClosed: boolean | null;
    /** Names of all metrics the vehicle delivered */
    metricKeys: string[];
}

/**
 * @param value - Raw value
 */
function num(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.round(value * 100) / 100;
    }
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
        return Math.round(Number(value) * 100) / 100;
    }
    return null;
}

/**
 * @param value - Raw value
 */
function text(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 60) : null;
}

/**
 * @param value - ISO time
 */
function time(value: unknown): number | null {
    const ms = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(ms) ? ms : null;
}

/**
 * Parses the telemetry answer.
 *
 * @param body - Answer of /telemetry
 */
export function parseTelemetry(body: Record<string, unknown>): VehicleState {
    const metrics =
        typeof body.metrics === 'object' && body.metrics !== null && !Array.isArray(body.metrics)
            ? (body.metrics as Record<string, unknown>)
            : {};
    const value = (key: string): unknown => {
        const entry = metrics[key];
        return typeof entry === 'object' && entry !== null && !Array.isArray(entry)
            ? (entry as { value?: unknown }).value
            : undefined;
    };
    const list = (key: string): Record<string, unknown>[] =>
        Array.isArray(metrics[key])
            ? (metrics[key] as unknown[]).filter(
                  (e): e is Record<string, unknown> => typeof e === 'object' && e !== null,
              )
            : [];

    const tires: Record<string, number> = {};
    for (const tire of list('tirePressure')) {
        const wheel = WHEELS[typeof tire.vehicleWheel === 'string' ? tire.vehicleWheel.toUpperCase() : ''];
        const pressure = num(tire.value);
        if (wheel && pressure !== null) {
            tires[wheel] = pressure;
        }
    }
    const doors = list('doorStatus').map(door => text(door.value));
    const doorsClosed =
        doors.length === 0 || doors.some(d => d === null) ? null : doors.every(d => d?.toUpperCase() === 'CLOSED');

    return {
        updateTime: time(body.updateTime),
        fuelLevel: num(value('fuelLevel')),
        fuelRange: num(value('fuelRange')),
        soc: num(value('xevBatteryStateOfCharge')),
        evRange: num(value('xevBatteryRange')),
        plugStatus: text(value('xevPlugChargerStatus')),
        chargeStatus: text(value('xevBatteryChargeDisplayStatus')),
        timeToFull: num(value('xevBatteryTimeToFullCharge')),
        odometer: num(value('odometer')),
        battery12v: num(value('batteryStateOfCharge')),
        battery12vVoltage: num(value('batteryVoltage')),
        oilLife: num(value('oilLifeRemaining')),
        outsideTemp: num(value('outsideTemperature')),
        coolantTemp: num(value('engineCoolantTemp')),
        ignition: text(value('ignitionStatus')),
        alarm: text(value('alarmStatus')),
        tires,
        doorsClosed,
        metricKeys: Object.keys(metrics).sort(),
    };
}

/**
 * Copy of the answer without VIN, position and similar (for analysing new models).
 *
 * @param value - Any JSON value
 */
export function sanitize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sanitize);
    }
    if (typeof value === 'object' && value !== null) {
        const result: Record<string, unknown> = {};
        for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
            if (!PRIVATE_KEY.test(key)) {
                result[key] = sanitize(inner);
            }
        }
        return result;
    }
    // 17-character VIN-like strings anywhere are masked as well
    if (typeof value === 'string' && /\b[A-HJ-NPR-Z0-9]{17}\b/.test(value)) {
        return value.replace(/\b[A-HJ-NPR-Z0-9]{17}\b/g, '<vin>');
    }
    return value;
}
