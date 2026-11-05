/*
 * Easee observations (replacement of the removed GET /api/chargers/{id}/state, gone since
 * 2026-09-01). IDs and enums from developer.easee.com "Charger Observation Ids" and
 * "Enumerations" (checked 2026-11-05).
 *
 * The documented data types are not reliable (other projects report Integer/Double swapped,
 * e.g. 104, 111-114), so every value is coerced to the type we need instead of trusting dataType.
 * Only what the dashboard and the commands need is requested (data minimisation, ISO/IEC 27402):
 * no WiFi SSID, IP addresses, RFID tokens, site structure or session JSON.
 */

/** Observation IDs we read */
export const OBS = {
    isEnabled: 31,
    phaseMode: 38,
    authorizationRequired: 42,
    maxChargerCurrent: 47,
    dynamicChargerCurrent: 48,
    reasonForNoCurrent: 96,
    smartCharging: 102,
    cableLocked: 103,
    opMode: 109,
    outputCurrent: 114,
    errorCode: 119,
    totalPower: 120,
    sessionEnergy: 121,
    lifetimeEnergy: 124,
    connectedToCloud: 250,
} as const;

/** All requested IDs, comma separated for the ids query parameter */
export const OBSERVATION_IDS: readonly number[] = Object.values(OBS);

/** Charger op mode (observation 109) */
export const OP_MODE = {
    offline: 0,
    disconnected: 1,
    awaitingStart: 2,
    charging: 3,
    completed: 4,
    error: 5,
    readyToCharge: 6,
    awaitingAuthentication: 7,
    deauthenticating: 8,
} as const;

/** Op mode texts for common.states */
export const OP_MODE_STATES: Record<number, string> = {
    0: 'Offline',
    1: 'Disconnected',
    2: 'Awaiting start',
    3: 'Charging',
    4: 'Completed',
    5: 'Error',
    6: 'Ready to charge',
    7: 'Awaiting authentication',
    8: 'Deauthenticating',
};

/**
 * Reason for no / limited current (observation 96). The official enumeration only groups the
 * codes ("Error" for 7-11 and 25-30), which is misleading: a real charge on 2026-11-05 reported
 * a 25-30 code while charging normally. Texts per code as in pyeasee (MIT), checked 2026-11-05.
 */
export const REASON_TEXTS: Readonly<Record<number, string>> = {
    0: 'OK',
    1: 'Max circuit limit too low',
    2: 'Max dynamic circuit limit too low',
    3: 'Max dynamic offline limit too low',
    4: 'Circuit fuse too low',
    5: 'Waiting in queue',
    6: 'Waiting in fully',
    7: 'Illegal grid type',
    8: 'No current request received',
    9: 'Not connected to master',
    10: 'Equalizer current too low',
    11: 'Phase not connected',
    25: 'Limited by circuit fuse',
    26: 'Limited by circuit max limit',
    27: 'Limited by circuit dynamic limit',
    28: 'Limited by equalizer',
    29: 'Limited by load balancing',
    30: 'Limited by offline settings',
    50: 'No car connected or no current request',
    51: 'Max charger limit too low',
    52: 'Max dynamic charger limit too low',
    53: 'Charger disabled',
    54: 'Waiting for schedule/authorization',
    55: 'Pending authorization',
    56: 'Charger in error state',
    57: 'EV erratic',
    75: 'Limited by cable rating',
    76: 'Limited by schedule',
    77: 'Limited by charger max limit',
    78: 'Limited by charger dynamic limit',
    79: 'EV is not charging',
    80: 'Limited by local adjustment',
    81: 'Limited by EV',
    100: 'Undefined',
};

/**
 * Text for the reason code; unknown codes are shown with their number.
 *
 * @param code - Raw code
 */
export function reasonText(code: number | null): string {
    if (code === null) {
        return '';
    }
    return REASON_TEXTS[code] ?? `Code ${code}`;
}

/** One observation as delivered by the API */
export interface RawObservation {
    /** Observation ID */
    id: number;
    /** Value (type varies) */
    value: unknown;
    /** ISO timestamp */
    timestamp: string;
}

/** Parsed charger state; null = not reported */
export interface ChargerState {
    /** Connected to the Easee cloud (250) */
    online: boolean | null;
    /** Op mode (109) */
    opMode: number | null;
    /** Charger enabled (31) */
    enabled: boolean | null;
    /** Phase mode (38): 1 = 1-phase, 2 = auto, 3 = 3-phase (real charger 2026-11-05 reports 2) */
    phaseMode: number | null;
    /** RFID / app authorization needed before charging (42) */
    authorizationRequired: boolean | null;
    /** Max charger current in A (47) */
    maxCurrent: number | null;
    /** Dynamic charger current in A (48), 0 after pause_charging */
    dynamicCurrent: number | null;
    /** Reason for no current (96) */
    reasonForNoCurrent: number | null;
    /** Smart charging on (102) */
    smartCharging: boolean | null;
    /** Cable locked (103) */
    cableLocked: boolean | null;
    /** Current offered to the car in A (114) */
    outputCurrent: number | null;
    /** Error code (119), 0 = none */
    errorCode: number | null;
    /** Power in kW (120) */
    power: number | null;
    /** Energy of the current / last session in kWh (121) */
    sessionEnergy: number | null;
    /** Lifetime energy in kWh (124) */
    lifetimeEnergy: number | null;
    /** Newest timestamp of all observations (epoch ms), null if none */
    latestPulse: number | null;
}

/**
 * Number from number, numeric string or boolean.
 *
 * @param value - Raw value
 */
export function toNumber(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'boolean') {
        return value ? 1 : 0;
    }
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
        return Number(value);
    }
    return null;
}

/**
 * Boolean from boolean, 0/1 or "true"/"false".
 *
 * @param value - Raw value
 */
export function toBoolean(value: unknown): boolean | null {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return value !== 0;
    }
    if (typeof value === 'string') {
        const text = value.trim().toLowerCase();
        if (text === 'true' || text === '1') {
            return true;
        }
        if (text === 'false' || text === '0') {
            return false;
        }
    }
    return null;
}

/**
 * @param value - Raw value
 * @param digits - Decimal places
 */
function rounded(value: unknown, digits: number): number | null {
    const number = toNumber(value);
    if (number === null) {
        return null;
    }
    const factor = 10 ** digits;
    return Math.round(number * factor) / factor;
}

/**
 * @param value - Raw value
 */
function integer(value: unknown): number | null {
    const number = toNumber(value);
    return number === null ? null : Math.round(number);
}

/**
 * Builds the charger state from the observations of one answer.
 *
 * @param observations - Parsed observations (unknown IDs are ignored)
 */
export function parseChargerState(observations: RawObservation[]): ChargerState {
    const byId = new Map<number, RawObservation>();
    let latestPulse: number | null = null;
    for (const observation of observations) {
        byId.set(observation.id, observation);
        const time = Date.parse(observation.timestamp);
        if (Number.isFinite(time) && (latestPulse === null || time > latestPulse)) {
            latestPulse = time;
        }
    }
    const value = (id: number): unknown => byId.get(id)?.value;
    const opMode = integer(value(OBS.opMode));
    return {
        online: toBoolean(value(OBS.connectedToCloud)),
        opMode: opMode !== null && opMode >= 0 && opMode <= 8 ? opMode : null,
        enabled: toBoolean(value(OBS.isEnabled)),
        phaseMode: integer(value(OBS.phaseMode)),
        authorizationRequired: toBoolean(value(OBS.authorizationRequired)),
        maxCurrent: rounded(value(OBS.maxChargerCurrent), 1),
        dynamicCurrent: rounded(value(OBS.dynamicChargerCurrent), 1),
        reasonForNoCurrent: integer(value(OBS.reasonForNoCurrent)),
        smartCharging: toBoolean(value(OBS.smartCharging)),
        cableLocked: toBoolean(value(OBS.cableLocked)),
        outputCurrent: rounded(value(OBS.outputCurrent), 1),
        errorCode: integer(value(OBS.errorCode)),
        power: rounded(value(OBS.totalPower), 3),
        sessionEnergy: rounded(value(OBS.sessionEnergy), 3),
        lifetimeEnergy: rounded(value(OBS.lifetimeEnergy), 3),
        latestPulse,
    };
}

/**
 * A car is plugged in (op modes 2, 3, 4, 6, 7).
 *
 * @param opMode - Op mode
 */
export function isCarConnected(opMode: number | null): boolean | null {
    if (opMode === null) {
        return null;
    }
    return (
        opMode === OP_MODE.awaitingStart ||
        opMode === OP_MODE.charging ||
        opMode === OP_MODE.completed ||
        opMode === OP_MODE.readyToCharge ||
        opMode === OP_MODE.awaitingAuthentication
    );
}
