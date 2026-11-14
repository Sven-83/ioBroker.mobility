/*
 * Object tree of the Easee part:
 *
 * easee                        device   Easee chargers
 * ├─ streamConnected           indicator.connected  SignalR real-time stream up
 * └─ charger<N>                channel  N = 1, 2, ... in the order of the serial numbers
 *    ├─ name                   text     name from the Easee app
 *    ├─ online                 indicator.reachable
 *    ├─ opMode / status        op mode (number with states) and its text
 *    ├─ carConnected, charging indicators for the dashboard
 *    ├─ power (kW), sessionEnergy / lifetimeEnergy (kWh), sessionCost (EUR)
 *    ├─ dynamicCurrent, maxCurrent, outputCurrent (A), phaseMode
 *    ├─ cableLocked, smartCharging, authorizationRequired, enabled
 *    ├─ reasonForNoCurrent / reasonText, errorCode, lastUpdate
 *    ├─ charge                 switch   write true = start/resume, false = stop/pause
 *    ├─ refresh                button   read the values now
 *    └─ history                channel  charging sessions (see sessions.ts / sessions-sync.ts)
 * easee.history                channel  the same summed over all chargers
 *    weeks / months (JSON), monthEnergy / yearEnergy (kWh), monthCost / yearCost (EUR),
 *    lastSession (JSON), oldestSession, sessionCount, lastSync (charger only)
 *
 * Serial numbers are not part of object IDs or states (data minimisation); the slot is enough.
 */

import type { ObjectDefinition } from '../fuel/objects';
import { OP_MODE_STATES } from './observations';

export const EASEE_ROOT = 'easee';

/**
 * @param slot - 1-based slot
 */
export function chargerChannel(slot: number): string {
    return `${EASEE_ROOT}.charger${slot}`;
}

/**
 * Parses a command state ID like "mobility.0.easee.charger2.charge".
 *
 * @param namespace - Adapter namespace
 * @param id - Full state ID
 * @returns Slot and state name, undefined for other IDs
 */
export function parseChargerCommandId(
    namespace: string,
    id: string,
): { slot: number; command: 'charge' | 'refresh' } | undefined {
    const prefix = `${namespace}.${EASEE_ROOT}.charger`;
    if (!id.startsWith(prefix)) {
        return undefined;
    }
    const [slotText, command, ...rest] = id.slice(prefix.length).split('.');
    const slot = Number(slotText);
    if (rest.length > 0 || !/^\d+$/.test(slotText) || (command !== 'charge' && command !== 'refresh')) {
        return undefined;
    }
    return { slot, command };
}

/**
 * @param en - English
 * @param de - German
 */
function n(en: string, de: string): ioBroker.StringOrTranslated {
    return { en, de };
}

/**
 * @param id - Relative ID
 * @param name - Name
 * @param common - Rest of common
 */
function state(
    id: string,
    name: ioBroker.StringOrTranslated,
    common: Partial<ioBroker.StateCommon> & Pick<ioBroker.StateCommon, 'type' | 'role'>,
): ObjectDefinition {
    return {
        id,
        obj: { type: 'state', common: { name, read: true, write: false, ...common }, native: {} },
    };
}

/** The device object */
export function rootObjects(): ObjectDefinition[] {
    return [
        {
            id: EASEE_ROOT,
            obj: { type: 'device', common: { name: n('Easee chargers', 'Easee-Wallboxen') }, native: {} },
        },
        state(`${EASEE_ROOT}.streamConnected`, n('Real-time stream connected', 'Echtzeit-Stream verbunden'), {
            type: 'boolean',
            role: 'indicator.connected',
        }),
    ];
}

/**
 * @param slot - 1-based slot
 * @param name - Name from the Easee app
 * @param withCost - Create the cost state (price configured)
 */
export function chargerObjects(slot: number, name: string, withCost: boolean): ObjectDefinition[] {
    const ch = chargerChannel(slot);
    const amps = { type: 'number', role: 'value.current', unit: 'A' } as const;
    const list: ObjectDefinition[] = [
        { id: ch, obj: { type: 'channel', common: { name: name || `Charger ${slot}` }, native: {} } },
        state(`${ch}.name`, n('Name', 'Name'), { type: 'string', role: 'info.name' }),
        state(`${ch}.online`, n('Connected to the Easee cloud', 'Mit der Easee-Cloud verbunden'), {
            type: 'boolean',
            role: 'indicator.reachable',
        }),
        state(`${ch}.opMode`, n('Operating mode', 'Betriebszustand'), {
            type: 'number',
            role: 'value',
            states: OP_MODE_STATES,
        }),
        state(`${ch}.status`, n('Operating mode (text)', 'Betriebszustand (Text)'), { type: 'string', role: 'text' }),
        state(`${ch}.carConnected`, n('Car plugged in', 'Auto eingesteckt'), { type: 'boolean', role: 'indicator' }),
        state(`${ch}.charging`, n('Charging', 'Lädt'), { type: 'boolean', role: 'indicator.working' }),
        state(`${ch}.power`, n('Charging power', 'Ladeleistung'), {
            type: 'number',
            role: 'value.power',
            unit: 'kW',
        }),
        state(`${ch}.sessionEnergy`, n('Energy of the current/last session', 'Energie der aktuellen/letzten Ladung'), {
            type: 'number',
            role: 'value.energy',
            unit: 'kWh',
        }),
        state(`${ch}.lifetimeEnergy`, n('Total energy (meter)', 'Gesamtenergie (Zähler)'), {
            type: 'number',
            role: 'value.energy.consumed',
            unit: 'kWh',
        }),
        state(`${ch}.dynamicCurrent`, n('Dynamic charger current', 'Dynamischer Ladestrom'), amps),
        state(`${ch}.maxCurrent`, n('Max charger current', 'Maximaler Ladestrom'), amps),
        state(`${ch}.outputCurrent`, n('Current offered to the car', 'Dem Auto angebotener Strom'), amps),
        state(`${ch}.phaseMode`, n('Phase mode', 'Phasenmodus'), {
            type: 'number',
            role: 'value',
            states: { 1: '1-phase', 2: 'Auto', 3: '3-phase' },
        }),
        state(`${ch}.cableLocked`, n('Cable locked', 'Kabel verriegelt'), {
            type: 'boolean',
            role: 'indicator.lock',
        }),
        state(`${ch}.smartCharging`, n('Smart charging', 'Smart Charging'), { type: 'boolean', role: 'indicator' }),
        state(`${ch}.authorizationRequired`, n('Authorization required', 'Autorisierung nötig'), {
            type: 'boolean',
            role: 'indicator',
        }),
        state(`${ch}.enabled`, n('Charger enabled', 'Wallbox aktiviert'), { type: 'boolean', role: 'indicator' }),
        state(`${ch}.reasonForNoCurrent`, n('Reason for no current (code)', 'Grund für keinen Strom (Code)'), {
            type: 'number',
            role: 'value',
        }),
        state(`${ch}.reasonText`, n('Reason for no current', 'Grund für keinen Strom'), {
            type: 'string',
            role: 'text',
        }),
        state(`${ch}.errorCode`, n('Error code (0 = none)', 'Fehlercode (0 = keiner)'), {
            type: 'number',
            role: 'value',
        }),
        state(`${ch}.lastUpdate`, n('Last value from the charger', 'Letzter Wert der Wallbox'), {
            type: 'number',
            role: 'value.time',
        }),
        state(`${ch}.charge`, n('Charge (true = start, false = stop)', 'Laden (true = Start, false = Stopp)'), {
            type: 'boolean',
            role: 'switch',
            write: true,
        }),
        state(`${ch}.refresh`, n('Read values now', 'Werte jetzt lesen'), {
            type: 'boolean',
            role: 'button',
            read: false,
            write: true,
        }),
    ];
    if (withCost) {
        list.push(
            state(`${ch}.sessionCost`, n('Cost of the current/last session', 'Kosten der aktuellen/letzten Ladung'), {
                type: 'number',
                role: 'value',
                unit: '€',
            }),
        );
    }
    return list;
}

/**
 * Charging-session states below easee.history or easee.chargerN.history.
 *
 * @param prefix - easee or easee.chargerN
 * @param withCost - Create the cost states (price configured)
 */
export function historyObjects(prefix: string, withCost: boolean): ObjectDefinition[] {
    const p = `${prefix}.history`;
    const json = { type: 'string', role: 'json' } as const;
    const kwh = { type: 'number', role: 'value.energy', unit: 'kWh' } as const;
    const eur = { type: 'number', role: 'value', unit: '€' } as const;
    const list: ObjectDefinition[] = [
        {
            id: p,
            obj: { type: 'channel', common: { name: n('Charging sessions', 'Ladevorgänge') }, native: {} },
        },
        state(`${p}.days`, n('Last 14 days (JSON)', 'Letzte 14 Tage (JSON)'), json),
        state(`${p}.weeks`, n('Last 12 weeks (JSON)', 'Letzte 12 Wochen (JSON)'), json),
        state(`${p}.months`, n('Last 13 months (JSON)', 'Letzte 13 Monate (JSON)'), json),
        state(`${p}.monthEnergy`, n('Charged this month', 'Geladen diesen Monat'), kwh),
        state(`${p}.yearEnergy`, n('Charged this year', 'Geladen dieses Jahr'), kwh),
        state(`${p}.lastSession`, n('Last session (JSON)', 'Letzte Ladung (JSON)'), json),
        state(`${p}.oldestSession`, n('First known session', 'Erste bekannte Ladung'), {
            type: 'number',
            role: 'value.time',
        }),
        state(`${p}.sessionCount`, n('Known sessions', 'Bekannte Ladevorgänge'), { type: 'number', role: 'value' }),
    ];
    if (prefix !== EASEE_ROOT) {
        list.push(
            state(`${p}.lastSync`, n('Sessions read from Easee', 'Ladevorgänge von Easee gelesen'), {
                type: 'number',
                role: 'value.time',
            }),
        );
    }
    if (withCost) {
        list.push(
            state(`${p}.monthCost`, n('Charging cost this month', 'Ladekosten diesen Monat'), eur),
            state(`${p}.yearCost`, n('Charging cost this year', 'Ladekosten dieses Jahr'), eur),
        );
    }
    return list;
}
