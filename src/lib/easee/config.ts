/*
 * Validation of the Easee part of the instance config.
 */

/** Poll interval limits in seconds (observations: 100 requests / 5 min per account) */
export const MIN_INTERVAL_SEC = 30;
export const MAX_INTERVAL_SEC = 600;
export const DEFAULT_INTERVAL_SEC = 60;

/** Number of charger slots in the admin */
export const CHARGER_SLOTS = 2;

/** Default electricity price for the charging costs in EUR/kWh */
export const DEFAULT_PRICE_PER_KWH = 0.35;

/** Validated Easee config */
export interface EaseeConfig {
    /** Part switched on and complete */
    enabled: boolean;
    /** E-mail or phone number */
    userName: string;
    /** Password */
    password: string;
    /** Poll interval in seconds */
    intervalSec: number;
    /** Electricity price in EUR/kWh, 0 = no cost states */
    pricePerKwh: number;
    /** Use the SignalR real-time stream */
    stream: boolean;
    /**
     * Chargers to use, by name as shown in the Easee app (slot = index + 1, empty = slot unused).
     * An account can see many chargers (e.g. a site admin sees the whole car park); only these
     * are read, subscribed and switched.
     */
    chargerNames: string[];
}

/** Raw native fields the part reads */
export interface EaseeNative {
    /** On/off */
    easeeEnabled?: unknown;
    /** User name */
    easeeUser?: unknown;
    /** Password */
    easeePassword?: unknown;
    /** Interval in seconds */
    easeeInterval?: unknown;
    /** Price in EUR/kWh */
    easeePrice?: unknown;
    /** Real-time stream on/off */
    easeeStream?: unknown;
    /** Name of charger 1 in the Easee app */
    easeeCharger1?: unknown;
    /** Name of charger 2 in the Easee app */
    easeeCharger2?: unknown;
}

/**
 * @param native - Instance config
 * @returns Config plus problems for the log (never containing the password)
 */
export function readEaseeConfig(native: EaseeNative): { config: EaseeConfig; problems: string[] } {
    const problems: string[] = [];
    const userName = typeof native.easeeUser === 'string' ? native.easeeUser.trim() : '';
    // passwords may contain spaces; only strip line breaks that come in with pasting
    const password = typeof native.easeePassword === 'string' ? native.easeePassword.replace(/[\r\n]/g, '') : '';

    let intervalSec = Number(native.easeeInterval);
    if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
        intervalSec = DEFAULT_INTERVAL_SEC;
    }
    intervalSec = Math.min(Math.max(Math.round(intervalSec), MIN_INTERVAL_SEC), MAX_INTERVAL_SEC);

    let pricePerKwh = native.easeePrice === undefined ? DEFAULT_PRICE_PER_KWH : Number(native.easeePrice);
    if (!Number.isFinite(pricePerKwh) || pricePerKwh < 0 || pricePerKwh > 5) {
        problems.push('electricity price must be between 0 and 5 EUR/kWh - charging costs are off');
        pricePerKwh = 0;
    }

    const wanted = native.easeeEnabled === true;
    if (wanted && (!userName || !password)) {
        problems.push('user name or password missing - Easee stays off');
    }
    // Easee: a phone number as user name needs the country code (real login 2026-11-05: HTTP 400 without)
    if (wanted && /^0?\d{6,}$/.test(userName.replace(/[\s/-]/g, ''))) {
        problems.push('the user name looks like a phone number without country code - use e.g. +49...');
    }

    const raw = [native.easeeCharger1, native.easeeCharger2];
    const chargerNames: string[] = [];
    for (let i = 0; i < CHARGER_SLOTS; i++) {
        const name = typeof raw[i] === 'string' ? (raw[i] as string).trim() : '';
        if (name && chargerNames.some(other => other.toLowerCase() === name.toLowerCase())) {
            problems.push(`charger ${i + 1} has the same name as another charger - ignored`);
            chargerNames.push('');
            continue;
        }
        chargerNames.push(name);
    }
    return {
        config: {
            enabled: wanted && userName !== '' && password !== '',
            userName,
            password,
            intervalSec,
            pricePerKwh: Math.round(pricePerKwh * 10_000) / 10_000,
            stream: native.easeeStream !== false,
            chargerNames,
        },
        problems,
    };
}
