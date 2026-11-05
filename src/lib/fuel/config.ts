/*
 * Validation of the fuel part of the instance config. Everything that reaches a URL or an
 * object ID is checked here; invalid entries are skipped with a reason instead of crashing.
 *
 * Exactly two fixed station slots (decision 2026-11-05: only E10, only two stations near home).
 */

import { API_KEY_PATTERN, STATION_ID_PATTERN, normalizeApiKey } from './tankerkoenig';

/** Number of station slots in the admin */
export const STATION_SLOTS = 2;
/** Minimum poll interval in minutes (Tankerkoenig terms for home automation) */
export const MIN_INTERVAL_MIN = 5;
/** Maximum poll interval in minutes */
export const MAX_INTERVAL_MIN = 60;
/** Default poll interval in minutes */
export const DEFAULT_INTERVAL_MIN = 10;

/** One configured station */
export interface FuelStationConfig {
    /** Tankerkoenig station ID (lower case UUID) */
    id: string;
    /** Display name chosen by the user */
    name: string;
    /** Slot in the admin (1 or 2), also the object ID suffix (fuel.station1 / fuel.station2) */
    slot: number;
}

/** Validated fuel config */
export interface FuelConfig {
    /** Key, at least one station and switch complete */
    enabled: boolean;
    /** Normalised API key */
    apiKey: string;
    /** Valid stations (1 or 2) */
    stations: FuelStationConfig[];
    /** Poll interval in minutes (5-60) */
    intervalMin: number;
}

/** Result of the validation */
export interface FuelConfigResult {
    /** Validated config */
    config: FuelConfig;
    /** Problems for the log (never contain the key) */
    problems: string[];
}

/** The raw config fields of one slot */
const SLOT_FIELDS = [
    { slot: 1, id: 'fuelStation1Id', name: 'fuelStation1Name' },
    { slot: 2, id: 'fuelStation2Id', name: 'fuelStation2Name' },
] as const;

/**
 * @param native - Instance config (this.config)
 */
export function readFuelConfig(native: Partial<ioBroker.AdapterConfig>): FuelConfigResult {
    const problems: string[] = [];

    const apiKey = normalizeApiKey(native.fuelApiKey);
    if (apiKey && !API_KEY_PATTERN.test(apiKey)) {
        problems.push('Tankerkoenig API key has an invalid format (expected 00000000-0000-0000-0000-000000000000)');
    }

    const stations: FuelStationConfig[] = [];
    for (const fields of SLOT_FIELDS) {
        const rawId = native[fields.id];
        const rawName = native[fields.name];
        const id = typeof rawId === 'string' ? rawId.trim().toLowerCase() : '';
        const name = typeof rawName === 'string' ? rawName.trim().slice(0, 60) : '';
        if (!id) {
            continue; // slot not used
        }
        if (!STATION_ID_PATTERN.test(id)) {
            problems.push(`Station ${fields.slot}: invalid station ID (expected UUID), skipped`);
            continue;
        }
        if (stations.some(station => station.id === id)) {
            problems.push(`Station ${fields.slot}: same ID as station 1, skipped`);
            continue;
        }
        stations.push({ id, name: name || `Station ${fields.slot}`, slot: fields.slot });
    }

    let intervalMin = Number(native.fuelInterval);
    if (!Number.isFinite(intervalMin)) {
        intervalMin = DEFAULT_INTERVAL_MIN;
    }
    if (intervalMin < MIN_INTERVAL_MIN || intervalMin > MAX_INTERVAL_MIN) {
        problems.push(
            `Poll interval ${intervalMin} min outside ${MIN_INTERVAL_MIN}-${MAX_INTERVAL_MIN} min, using the nearest limit`,
        );
        intervalMin = Math.min(Math.max(intervalMin, MIN_INTERVAL_MIN), MAX_INTERVAL_MIN);
    }
    intervalMin = Math.round(intervalMin);

    const enabled = native.fuelEnabled !== false && API_KEY_PATTERN.test(apiKey) && stations.length > 0;
    return { config: { enabled, apiKey, stations, intervalMin }, problems };
}
