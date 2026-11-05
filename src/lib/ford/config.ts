/*
 * Validation of the Ford part of the instance config.
 */

/** Poll interval limits in minutes (project decision: careful polling, account lock risk) */
export const MIN_INTERVAL_MIN = 5;
export const MAX_INTERVAL_MIN = 60;
export const DEFAULT_INTERVAL_MIN = 30;

/** Redirect URI that has to be entered in the Ford developer portal as well */
export const DEFAULT_REDIRECT_URI = 'http://localhost/fordconnect';

/** Vehicle slots in the admin */
export const VEHICLE_SLOTS = 2;

/** One configured vehicle */
export interface FordVehicleConfig {
    /** Slot 1 or 2 (ford.vehicle1 / ford.vehicle2) */
    slot: number;
    /** Display name, e.g. "Family car" */
    name: string;
}

/** Validated Ford config */
export interface FordConfig {
    /** Part switched on and complete */
    enabled: boolean;
    /** App client ID */
    clientId: string;
    /** App client secret */
    clientSecret: string;
    /** Redirect URI */
    redirectUri: string;
    /** Poll interval in minutes */
    intervalMin: number;
    /** Vehicles (each needs its own browser login) */
    vehicles: FordVehicleConfig[];
}

/** Raw native fields the part reads */
export interface FordNative {
    /** On/off */
    fordEnabled?: unknown;
    /** Client ID */
    fordClientId?: unknown;
    /** Client secret */
    fordClientSecret?: unknown;
    /** Redirect URI */
    fordRedirectUri?: unknown;
    /** Interval in minutes */
    fordInterval?: unknown;
    /** Name of vehicle 1 */
    fordVehicle1Name?: unknown;
    /** Name of vehicle 2 */
    fordVehicle2Name?: unknown;
}

/**
 * @param value - Raw value
 */
function clean(value: unknown): string {
    // eslint-disable-next-line no-control-regex -- removing control chars from pasted values
    return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
}

/**
 * @param native - Instance config
 * @returns Config plus problems for the log (never containing the secret)
 */
export function readFordConfig(native: FordNative): { config: FordConfig; problems: string[] } {
    const problems: string[] = [];
    const clientId = clean(native.fordClientId);
    const clientSecret = clean(native.fordClientSecret);
    let redirectUri = clean(native.fordRedirectUri) || DEFAULT_REDIRECT_URI;
    try {
        const url = new URL(redirectUri);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new Error('protocol');
        }
    } catch {
        problems.push('redirect URI is not a valid http(s) address - using the default');
        redirectUri = DEFAULT_REDIRECT_URI;
    }

    let intervalMin = Number(native.fordInterval);
    if (!Number.isFinite(intervalMin) || intervalMin <= 0) {
        intervalMin = DEFAULT_INTERVAL_MIN;
    }
    intervalMin = Math.min(Math.max(Math.round(intervalMin), MIN_INTERVAL_MIN), MAX_INTERVAL_MIN);

    const vehicles: FordVehicleConfig[] = [];
    const names = [native.fordVehicle1Name, native.fordVehicle2Name];
    for (let i = 0; i < VEHICLE_SLOTS; i++) {
        const name = clean(names[i]).slice(0, 40);
        if (name) {
            vehicles.push({ slot: i + 1, name });
        }
    }

    const wanted = native.fordEnabled === true;
    if (wanted && (!clientId || !clientSecret)) {
        problems.push('client ID or client secret missing - Ford stays off');
    }
    if (wanted && vehicles.length === 0) {
        problems.push('no vehicle name entered - Ford stays off');
    }
    return {
        config: {
            enabled: wanted && clientId !== '' && clientSecret !== '' && vehicles.length > 0,
            clientId,
            clientSecret,
            redirectUri,
            intervalMin,
            vehicles,
        },
        problems,
    };
}
