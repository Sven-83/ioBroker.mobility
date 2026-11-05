/*
 * Object tree of the fuel part:
 *
 * fuel                         device   Fuel prices
 * ├─ cheapestStation           text     name of the cheapest open station (rated fuel)
 * ├─ cheapestPrice             value    its price
 * ├─ ranking                   json     stations sorted by price, for the widget
 * └─ station<N>                channel  one per configured station (N = row in the admin table)
 *    ├─ name, brand, address, status, open, lastUpdate
 *    ├─ e10                    value    current Super E10 price (EUR/l), null = no price
 *    └─ rating, rank, min7d, max7d, avg7d, coverage, bestHour, bestHourPrice,
 *       bestWeekday, bestWeekdayPrice    (all for E10, the only fuel we track)
 *
 * Station IDs (UUIDs) are not part of the object IDs; the row number is enough and keeps the
 * tree readable. All states are read-only (ack=true).
 */

/** One object to create or update */
export interface ObjectDefinition {
    /** ID relative to the adapter namespace */
    id: string;
    /** Object to create or extend */
    obj: ioBroker.SettableObject;
}

export const FUEL_ROOT = 'fuel';

/**
 * @param index - 1-based row of the station
 */
export function stationChannel(index: number): string {
    return `${FUEL_ROOT}.station${index}`;
}

/**
 * Bilingual name helper.
 *
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

/** Objects directly under "fuel" */
export function rootObjects(): ObjectDefinition[] {
    return [
        {
            id: FUEL_ROOT,
            obj: { type: 'device', common: { name: n('Fuel prices', 'Spritpreise') }, native: {} },
        },
        state(`${FUEL_ROOT}.cheapestStation`, n('Cheapest open station', 'Günstigste offene Tankstelle'), {
            type: 'string',
            role: 'text',
        }),
        state(`${FUEL_ROOT}.cheapestPrice`, n('Cheapest price', 'Günstigster Preis'), {
            type: 'number',
            role: 'value',
            unit: '€',
        }),
        state(`${FUEL_ROOT}.ranking`, n('Stations sorted by price (JSON)', 'Tankstellen nach Preis (JSON)'), {
            type: 'string',
            role: 'json',
        }),
    ];
}

/**
 * Objects of one station.
 *
 * @param index - 1-based row
 * @param name - Display name from the config
 */
export function stationObjects(index: number, name: string): ObjectDefinition[] {
    const ch = stationChannel(index);
    const label = 'E10';
    return [
        { id: ch, obj: { type: 'channel', common: { name }, native: {} } },
        state(`${ch}.name`, n('Name', 'Name'), { type: 'string', role: 'text' }),
        state(`${ch}.brand`, n('Brand', 'Marke'), { type: 'string', role: 'text' }),
        state(`${ch}.address`, n('Address', 'Adresse'), { type: 'string', role: 'text' }),
        state(`${ch}.status`, n('Status (open/closed/no prices)', 'Status (open/closed/no prices)'), {
            type: 'string',
            role: 'text',
        }),
        state(`${ch}.open`, n('Open', 'Geöffnet'), { type: 'boolean', role: 'indicator' }),
        state(`${ch}.lastUpdate`, n('Last price update', 'Letzte Preisabfrage'), {
            type: 'number',
            role: 'value.time',
        }),
        state(`${ch}.e10`, n('Price Super E10', 'Preis Super E10'), { type: 'number', role: 'value', unit: '€' }),
        state(`${ch}.rating`, n(`${label} rating (7 days)`, `${label} Bewertung (7 Tage)`), {
            type: 'string',
            role: 'text',
            states: { cheap: 'cheap', normal: 'normal', expensive: 'expensive', unknown: 'unknown' },
        }),
        state(
            `${ch}.rank`,
            n(`${label}: share of time cheaper (7 days)`, `${label}: Anteil der Zeit günstiger (7 Tage)`),
            {
                type: 'number',
                role: 'value',
                unit: '%',
                min: 0,
                max: 100,
            },
        ),
        state(`${ch}.min7d`, n(`${label} minimum (7 days)`, `${label} Minimum (7 Tage)`), {
            type: 'number',
            role: 'value.min',
            unit: '€',
        }),
        state(`${ch}.max7d`, n(`${label} maximum (7 days)`, `${label} Maximum (7 Tage)`), {
            type: 'number',
            role: 'value.max',
            unit: '€',
        }),
        state(`${ch}.avg7d`, n(`${label} average (7 days)`, `${label} Durchschnitt (7 Tage)`), {
            type: 'number',
            role: 'value',
            unit: '€',
        }),
        state(`${ch}.coverage`, n('Recorded price history', 'Aufgezeichnete Preishistorie'), {
            type: 'number',
            role: 'value',
            unit: 'h',
        }),
        state(`${ch}.bestHour`, n('Usually cheapest hour (0-23)', 'Meist günstigste Stunde (0-23)'), {
            type: 'number',
            role: 'value',
            min: 0,
            max: 23,
        }),
        state(`${ch}.bestHourPrice`, n('Average price in that hour', 'Durchschnittspreis in dieser Stunde'), {
            type: 'number',
            role: 'value',
            unit: '€',
        }),
        state(`${ch}.bestWeekday`, n('Usually cheapest weekday', 'Meist günstigster Wochentag'), {
            type: 'number',
            role: 'value',
            min: 0,
            max: 6,
            states: {
                0: 'Sunday',
                1: 'Monday',
                2: 'Tuesday',
                3: 'Wednesday',
                4: 'Thursday',
                5: 'Friday',
                6: 'Saturday',
            },
        }),
        state(`${ch}.bestWeekdayPrice`, n('Average price on that weekday', 'Durchschnittspreis an diesem Wochentag'), {
            type: 'number',
            role: 'value',
            unit: '€',
        }),
    ];
}
