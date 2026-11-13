/*
 * Object tree of the Ford part:
 *
 * ford                          device
 * └─ vehicle<N>                 channel  N = slot 1/2 from the admin
 *    ├─ name, model, engineType
 *    ├─ login.url               text     open in the browser to log in (one login per vehicle)
 *    ├─ login.response          text     paste the address shown after the login here (write)
 *    ├─ login.status            text     OK / login needed / error
 *    ├─ login.expires           time     the browser login expires about one year after it was made
 *    ├─ login.token             (encrypted, internal)
 *    ├─ lastUpdate, fuelLevel, fuelRange (empty for BEV), soc, evRange, plugStatus, chargeStatus,
 *    │  timeToFull (empty when unplugged), energyRemaining, batteryCapacity, evMaxRange, batteryTemp,
 *    │  chargePower, odometer, battery12v, battery12vVoltage, battery12vLow, oilLife, outsideTemp,
 *    │  coolantTemp, ignition, alarm, doorsClosed, locked, windowsClosed
 *    ├─ tires.frontLeft/frontRight/rearLeft/rearRight   kPa
 *    ├─ warnings, warningLevel, warningCount   dashboard warnings (see warnings.ts)
 *    ├─ metricKeys              json     which metrics the vehicle delivers
 *    ├─ raw                     json     telemetry without VIN/vehicle ID/position (for mapping more later)
 *    └─ refresh                 button
 *
 * No VIN, no number plate, no position in IDs or states (project rule).
 */

import type { ObjectDefinition } from '../fuel/objects';
import { WHEELS } from './telemetry';

export const FORD_ROOT = 'ford';

/**
 * @param slot - Vehicle slot
 */
export function vehicleChannel(slot: number): string {
    return `${FORD_ROOT}.vehicle${slot}`;
}

/**
 * Parses a write to ford.vehicleN.login.response / ford.vehicleN.refresh.
 *
 * @param namespace - Adapter namespace
 * @param id - Full state ID
 */
export function parseVehicleCommandId(
    namespace: string,
    id: string,
): { slot: number; command: 'login' | 'refresh' } | undefined {
    const prefix = `${namespace}.${FORD_ROOT}.vehicle`;
    if (!id.startsWith(prefix)) {
        return undefined;
    }
    const rest = id.slice(prefix.length);
    const match = /^(\d+)\.(login\.response|refresh)$/.exec(rest);
    if (!match) {
        return undefined;
    }
    return { slot: Number(match[1]), command: match[2] === 'refresh' ? 'refresh' : 'login' };
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
    return { id, obj: { type: 'state', common: { name, read: true, write: false, ...common }, native: {} } };
}

/** The device object */
export function rootObjects(): ObjectDefinition[] {
    return [
        { id: FORD_ROOT, obj: { type: 'device', common: { name: n('Ford vehicles', 'Ford-Fahrzeuge') }, native: {} } },
    ];
}

/**
 * @param slot - Vehicle slot
 * @param name - Display name
 */
export function vehicleObjects(slot: number, name: string): ObjectDefinition[] {
    const ch = vehicleChannel(slot);
    const percent = { type: 'number', role: 'value', unit: '%' } as const;
    const km = { type: 'number', role: 'value.distance', unit: 'km' } as const;
    const kwh = { type: 'number', role: 'value.energy', unit: 'kWh' } as const;
    const list: ObjectDefinition[] = [
        { id: ch, obj: { type: 'channel', common: { name }, native: {} } },
        state(`${ch}.name`, n('Name', 'Name'), { type: 'string', role: 'info.name' }),
        state(`${ch}.model`, n('Model', 'Modell'), { type: 'string', role: 'info.model' }),
        state(`${ch}.engineType`, n('Engine type (ICE, BEV, ...)', 'Antrieb (ICE, BEV, ...)'), {
            type: 'string',
            role: 'text',
        }),
        {
            id: `${ch}.login`,
            obj: { type: 'folder', common: { name: n('Ford login', 'Ford-Anmeldung') }, native: {} },
        },
        state(`${ch}.login.url`, n('Login address (open in the browser)', 'Login-Adresse (im Browser öffnen)'), {
            type: 'string',
            role: 'url',
        }),
        state(
            `${ch}.login.response`,
            n('Paste the address after the login here', 'Adresse nach dem Login hier einfügen'),
            { type: 'string', role: 'text', write: true, def: '' },
        ),
        state(`${ch}.login.status`, n('Login status', 'Anmeldestatus'), { type: 'string', role: 'text' }),
        state(`${ch}.login.expires`, n('Login expires', 'Anmeldung läuft ab'), { type: 'number', role: 'value.time' }),
        state(`${ch}.login.token`, n('Token (encrypted, internal)', 'Token (verschlüsselt, intern)'), {
            type: 'string',
            role: 'text',
            read: false,
        }),
        state(`${ch}.lastUpdate`, n('Time of the vehicle data', 'Zeitpunkt der Fahrzeugdaten'), {
            type: 'number',
            role: 'value.time',
        }),
        state(`${ch}.fuelLevel`, n('Fuel level', 'Tankfüllung'), { ...percent, role: 'value.fill' }),
        state(`${ch}.fuelRange`, n('Fuel range', 'Reichweite (Kraftstoff)'), km),
        state(`${ch}.soc`, n('Battery (high voltage)', 'Akku (Hochvolt)'), { ...percent, role: 'value.battery' }),
        state(`${ch}.evRange`, n('Electric range', 'Reichweite (elektrisch)'), km),
        state(`${ch}.plugStatus`, n('Charging plug', 'Ladestecker'), { type: 'string', role: 'text' }),
        state(`${ch}.chargeStatus`, n('Charging status', 'Ladestatus'), { type: 'string', role: 'text' }),
        state(`${ch}.timeToFull`, n('Time until full', 'Zeit bis voll'), {
            type: 'number',
            role: 'value.interval',
            unit: 'min',
        }),
        state(`${ch}.energyRemaining`, n('Battery energy left', 'Akku-Restenergie'), kwh),
        state(`${ch}.batteryCapacity`, n('Battery capacity (usable)', 'Akku-Kapazität (nutzbar)'), kwh),
        state(`${ch}.evMaxRange`, n('Electric range at 100 %', 'Reichweite bei 100 %'), km),
        state(`${ch}.batteryTemp`, n('Battery temperature (high voltage)', 'Akkutemperatur (Hochvolt)'), {
            type: 'number',
            role: 'value.temperature',
            unit: '°C',
        }),
        state(`${ch}.chargePower`, n('Charging power', 'Ladeleistung'), {
            type: 'number',
            role: 'value.power',
            unit: 'kW',
        }),
        state(`${ch}.odometer`, n('Odometer', 'Kilometerstand'), km),
        state(`${ch}.battery12v`, n('12 V battery', '12-V-Batterie'), percent),
        state(`${ch}.battery12vVoltage`, n('12 V battery voltage', '12-V-Batteriespannung'), {
            type: 'number',
            role: 'value.voltage',
            unit: 'V',
        }),
        state(`${ch}.battery12vLow`, n('12 V battery weak', '12-V-Batterie schwach'), {
            type: 'boolean',
            role: 'indicator.lowbat',
        }),
        state(`${ch}.oilLife`, n('Oil life', 'Öl-Restlebensdauer'), percent),
        state(`${ch}.outsideTemp`, n('Outside temperature', 'Außentemperatur'), {
            type: 'number',
            role: 'value.temperature',
            unit: '°C',
        }),
        state(`${ch}.coolantTemp`, n('Coolant temperature', 'Kühlmitteltemperatur'), {
            type: 'number',
            role: 'value.temperature',
            unit: '°C',
        }),
        state(`${ch}.ignition`, n('Ignition', 'Zündung'), { type: 'string', role: 'text' }),
        state(`${ch}.alarm`, n('Alarm', 'Alarmanlage'), { type: 'string', role: 'text' }),
        state(`${ch}.doorsClosed`, n('All doors closed', 'Alle Türen zu'), { type: 'boolean', role: 'indicator' }),
        state(`${ch}.locked`, n('Locked', 'Verriegelt'), { type: 'boolean', role: 'indicator.lock' }),
        state(`${ch}.windowsClosed`, n('All windows closed', 'Alle Fenster zu'), {
            type: 'boolean',
            role: 'indicator',
        }),
        { id: `${ch}.tires`, obj: { type: 'folder', common: { name: n('Tyre pressure', 'Reifendruck') }, native: {} } },
        state(`${ch}.warnings`, n('Warnings (JSON, worst first)', 'Warnungen (JSON, schlimmste zuerst)'), {
            type: 'string',
            role: 'json',
        }),
        state(
            `${ch}.warningLevel`,
            n('Worst warning (critical/warning/info/none)', 'Schlimmste Warnung (critical/warning/info/none)'),
            {
                type: 'string',
                role: 'text',
                states: { critical: 'critical', warning: 'warning', info: 'info', none: 'none' },
            },
        ),
        state(`${ch}.warningCount`, n('Number of warnings', 'Anzahl Warnungen'), { type: 'number', role: 'value' }),
        state(`${ch}.metricKeys`, n('Metrics the vehicle delivers', 'Vom Fahrzeug gelieferte Werte'), {
            type: 'string',
            role: 'json',
        }),
        state(
            `${ch}.raw`,
            n('Telemetry without VIN/ID/position (JSON)', 'Telemetrie ohne FIN/Kennung/Standort (JSON)'),
            {
                type: 'string',
                role: 'json',
            },
        ),
        state(`${ch}.refresh`, n('Read values now', 'Werte jetzt lesen'), {
            type: 'boolean',
            role: 'button',
            read: false,
            write: true,
        }),
    ];
    for (const wheel of Object.values(WHEELS)) {
        list.push(
            state(`${ch}.tires.${wheel}`, n(`Tyre ${wheel}`, `Reifen ${wheel}`), {
                type: 'number',
                role: 'value.pressure',
                unit: 'kPa',
            }),
        );
    }
    return list;
}
