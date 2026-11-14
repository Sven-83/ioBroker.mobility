/*
 * Messages via a messenger instance (Telegram), opt-in (Sven 14.11.2026). Text only.
 *
 * The notifier reads along the values the other parts write (observe()) and needs no request of its own:
 *  - fuel:   a car that fills up has <= 25 % and the cheapest open station is rated "cheap";
 *            again after refuelling (> 30 %) or at the earliest the next day
 *  - full:   a charger goes from "charging" to "completed"; every time (own switch, off by default)
 *  - abort:  Ford reports a charging fault, or a charger goes from "charging" to "error";
 *            again only after the fault was gone
 *  - plug:   Ford warning "not plugged in" (evening, low battery); once per evening
 *  - tyres:  Ford warning "tyre loses air" per wheel; at most every 7 days per wheel
 * What was sent is kept in a state, so a restart repeats nothing. A stop by the user (charging -> waiting)
 * is no event.
 */

/** State that keeps the messages sent, relative to the instance */
export const NOTIFY_STATE = 'info.notifications';

export const FUEL_LEVEL = 25;
export const FUEL_REARM_LEVEL = 30;
const DAY_MS = 24 * 3_600_000;
const TYRE_REPEAT_MS = 7 * DAY_MS;

/** Easee op modes the notifier needs (same values as easee/observations.ts) */
const OP_CHARGING = 3;
const OP_COMPLETED = 4;
const OP_ERROR = 5;

export type MessageKind = 'fuel' | 'full' | 'charge' | 'plug' | 'tyres';

/** What the instance settings switch on */
export interface NotifyOptions {
    /** kinds switched on in the instance settings */
    kinds: Set<MessageKind>;
    /** language of the system is German */
    german: boolean;
}

/** What the notifier needs from the adapter */
export interface NotifyHost {
    /** Sends a message; rejects if it could not be delivered */
    send(text: string): Promise<void>;
    /** Stored value of NOTIFY_STATE */
    read(): Promise<ioBroker.StateValue | undefined>;
    /** Writes NOTIFY_STATE with ack: true */
    write(value: string): Promise<unknown>;
    /** Current time (epoch ms) */
    now(): number;
    /** Log message on level info */
    info(message: string): void;
    /** Log message on level warn */
    warn(message: string): void;
}

interface Entry {
    /** Time of the last message */
    at: number;
    /** The condition has held since that message */
    active: boolean;
}

/** One entry of ford.vehicleN.warnings */
interface Warning {
    /** Kind, e.g. tyreLoss */
    key: string;
    /** critical / warning / info */
    level?: string;
    /** Measured value */
    value?: number;
    /** Unit of the value */
    unit?: string;
    /** Wheel of a tyre warning */
    wheel?: string;
}

/** Electric car Ford reports as plugged in */
interface PluggedCar {
    /** Vehicle slot */
    slot: number;
    /** Its name */
    name: string;
}

/** One entry of fuel.ranking */
interface RankEntry {
    /** Station name */
    name?: unknown;
    /** Super E10 price */
    price?: unknown;
    /** cheap / normal / expensive */
    rating?: unknown;
}

const WHEEL_DE: Record<string, string> = {
    frontLeft: 'vorne links',
    frontRight: 'vorne rechts',
    rearLeft: 'hinten links',
    rearRight: 'hinten rechts',
};
const WHEEL_EN: Record<string, string> = {
    frontLeft: 'front left',
    frontRight: 'front right',
    rearLeft: 'rear left',
    rearRight: 'rear right',
};

/**
 * Number from a state value, null if there is none.
 *
 * @param value - State value
 */
function num(value: unknown): number | null {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
        return null;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/**
 * Trimmed text from a state value.
 *
 * @param value - State value
 */
function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * JSON list from a state value, empty if it is none.
 *
 * @param value - State value
 */
function parseList(value: unknown): unknown[] {
    try {
        const list: unknown = typeof value === 'string' && value ? JSON.parse(value) : [];
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
}

/**
 * Number in German or English style.
 *
 * @param n - Number
 * @param decimals - Decimals
 * @param german - German style
 */
export function fmt(n: number, decimals: number, german: boolean): string {
    return n.toLocaleString(german ? 'de-DE' : 'en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    });
}

/**
 * Local date "YYYY-MM-DD", for "once per evening".
 *
 * @param t - Epoch ms
 */
function day(t: number): string {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Decides which messages to send from the values the adapter writes */
export class Notifier {
    private readonly values = new Map<string, ioBroker.StateValue>();
    private sent: Record<string, Entry> = {};
    private loaded = false;
    /** sends one after the other, in the order of the events */
    private queue: Promise<void> = Promise.resolve();

    /**
     * @param host - Adapter functions
     * @param options - Instance settings
     */
    public constructor(
        private readonly host: NotifyHost,
        private readonly options: NotifyOptions,
    ) {}

    /** Reads what was sent before the restart */
    public async start(): Promise<void> {
        try {
            const raw = await this.host.read();
            const data: unknown = typeof raw === 'string' && raw ? JSON.parse(raw) : {};
            if (data && typeof data === 'object' && !Array.isArray(data)) {
                for (const [key, entry] of Object.entries(data as Record<string, unknown>)) {
                    const e = entry as Partial<Entry> | null;
                    if (e && typeof e.at === 'number' && typeof e.active === 'boolean') {
                        this.sent[key] = { at: e.at, active: e.active };
                    }
                }
            }
        } catch {
            this.sent = {};
        }
        this.loaded = true;
    }

    /** Waits until all queued messages are sent (tests, unload) */
    public flush(): Promise<void> {
        return this.queue;
    }

    /**
     * A value the adapter has just written.
     *
     * @param id - Relative state ID, e.g. easee.charger1.opMode
     * @param value - New value
     */
    public observe(id: string, value: ioBroker.StateValue): void {
        const before = this.values.get(id);
        this.values.set(id, value);
        if (!this.loaded) {
            return;
        }
        let m = /^easee\.charger(\d+)\.opMode$/.exec(id);
        if (m) {
            this.chargerChanged(Number(m[1]), num(before), num(value));
            return;
        }
        m = /^ford\.vehicle(\d+)\.warnings$/.exec(id);
        if (m) {
            this.warningsChanged(Number(m[1]), value);
            this.checkFuel();
            return;
        }
        if (/^ford\.vehicle\d+\.fuelLevel$/.test(id) || id === 'fuel.ranking') {
            this.checkFuel();
        }
    }

    // ---------------------------------------------------------------- rules

    private chargerChanged(slot: number, before: number | null, now: number | null): void {
        if (now === OP_CHARGING) {
            // charging again: a reported error is over
            this.once(`abort.charger${slot}`, false);
            return;
        }
        if (before !== OP_CHARGING) {
            return;
        }
        const g = this.options.german;
        const name = text(this.values.get(`easee.charger${slot}.name`)) || `Wallbox ${slot}`;
        const car = this.pluggedCar();
        if (now === OP_COMPLETED && this.on('full')) {
            const kwh = num(this.values.get(`easee.charger${slot}.sessionEnergy`));
            const cost = num(this.values.get(`easee.charger${slot}.sessionCost`));
            const soc = car ? num(this.values.get(`ford.vehicle${car.slot}.soc`)) : null;
            const parts = [
                kwh !== null ? `${fmt(kwh, 1, g)} kWh` : '',
                cost !== null ? `${fmt(cost, 2, g)} €` : '',
                soc !== null ? (g ? `Akku ${fmt(soc, 0, g)} %` : `battery ${fmt(soc, 0, g)} %`) : '',
            ].filter(Boolean);
            const who = car ? `${car.name} ` : '';
            this.send(
                g
                    ? `🔋 ${who}fertig geladen an ${name}${parts.length ? ` · ${parts.join(' · ')}` : ''}`
                    : `🔋 ${who}charging finished at ${name}${parts.length ? ` · ${parts.join(' · ')}` : ''}`,
            );
            return;
        }
        if (now === OP_ERROR && this.on('charge')) {
            const reason = text(this.values.get(`easee.charger${slot}.reasonText`));
            this.once(`abort.charger${slot}`, true, () =>
                g
                    ? `⚠️ Laden abgebrochen an ${name}: Wallbox meldet einen Fehler${reason ? ` (${reason})` : ''}`
                    : `⚠️ Charging stopped at ${name}: the charger reports an error${reason ? ` (${reason})` : ''}`,
            );
            return;
        }
        // charging -> anything else (stopped by the user, unplugged): the error is over
        this.once(`abort.charger${slot}`, false);
    }

    private warningsChanged(slot: number, value: ioBroker.StateValue): void {
        const g = this.options.german;
        const name = text(this.values.get(`ford.vehicle${slot}.name`)) || `${g ? 'Fahrzeug' : 'Vehicle'} ${slot}`;
        const list = parseList(value).filter((w): w is Warning => !!w && typeof w === 'object' && 'key' in w);
        const has = (key: string): Warning | undefined => list.find(w => w.key === key);

        if (this.on('charge')) {
            this.once(`abort.vehicle${slot}`, !!has('chargeFault'), () =>
                g
                    ? `⚠️ ${name}: Laden abgebrochen (meldet das Auto)`
                    : `⚠️ ${name}: charging stopped (reported by the car)`,
            );
        }
        const plugKey = `plug.vehicle${slot}.${day(this.host.now())}`;
        // once per evening: a warning that goes and comes back the same day sends nothing
        if (this.on('plug') && !this.sent[plugKey]) {
            const w = has('notPluggedIn');
            const soc = w?.value ?? num(this.values.get(`ford.vehicle${slot}.soc`));
            this.once(
                plugKey,
                !!w,
                () =>
                    g
                        ? `🔌 ${name} ist nicht eingesteckt${soc !== null && soc !== undefined ? ` · Akku ${fmt(soc, 0, g)} %` : ''}`
                        : `🔌 ${name} is not plugged in${soc !== null && soc !== undefined ? ` · battery ${fmt(soc, 0, g)} %` : ''}`,
                true,
            );
        }
        if (this.on('tyres')) {
            for (const wheel of Object.keys(WHEEL_DE)) {
                const w = list.find(x => x.key === 'tyreLoss' && x.wheel === wheel);
                const key = `tyre.vehicle${slot}.${wheel}`;
                const last = this.sent[key];
                if (w && last && !last.active && this.host.now() - last.at < TYRE_REPEAT_MS) {
                    continue; // less than 7 days since the last message for this wheel
                }
                this.once(key, !!w, () => {
                    const loss = w?.value !== undefined ? fmt(w.value, 2, g) : '';
                    return g
                        ? `🛞 ${name}: Reifen ${WHEEL_DE[wheel]} verliert Luft${loss ? ` (−${loss} bar in 7 Tagen)` : ''}. Bitte prüfen.`
                        : `🛞 ${name}: tyre ${WHEEL_EN[wheel]} is losing air${loss ? ` (−${loss} bar in 7 days)` : ''}. Please check.`;
                });
            }
        }
    }

    private checkFuel(): void {
        if (!this.on('fuel')) {
            return;
        }
        const g = this.options.german;
        const ranking = parseList(this.values.get('fuel.ranking')) as RankEntry[];
        const best = ranking[0];
        const cheap = !!best && best.rating === 'cheap' && num(best.price) !== null;
        for (const slot of this.vehicleSlots()) {
            if (text(this.values.get(`ford.vehicle${slot}.engineType`)).toUpperCase() === 'BEV') {
                continue;
            }
            const level = num(this.values.get(`ford.vehicle${slot}.fuelLevel`));
            if (level === null) {
                continue;
            }
            const key = `fuel.vehicle${slot}`;
            const last = this.sent[key];
            if (level > FUEL_REARM_LEVEL) {
                this.once(key, false);
                continue;
            }
            // still low: again at the earliest the next day
            if (last?.active && this.host.now() - last.at >= DAY_MS) {
                last.active = false;
            }
            if (level > FUEL_LEVEL || !cheap) {
                continue;
            }
            const name = text(this.values.get(`ford.vehicle${slot}.name`)) || `${g ? 'Fahrzeug' : 'Vehicle'} ${slot}`;
            const station = text(best.name);
            const price = fmt(num(best.price) as number, 3, g);
            this.once(key, true, () =>
                g
                    ? `⛽ ${name}: Tank ${fmt(level, 0, g)} % · ${station} ist gerade günstig: ${price} € (Super E10)`
                    : `⛽ ${name}: tank ${fmt(level, 0, g)} % · ${station} is cheap right now: ${price} € (Super E10)`,
            );
        }
    }

    // ---------------------------------------------------------------- helpers

    private on(kind: MessageKind): boolean {
        return this.options.kinds.has(kind);
    }

    private vehicleSlots(): number[] {
        const slots = new Set<number>();
        for (const id of this.values.keys()) {
            const m = /^ford\.vehicle(\d+)\./.exec(id);
            if (m) {
                slots.add(Number(m[1]));
            }
        }
        return [...slots].sort();
    }

    /** Electric car that Ford reports as plugged in (the wallbox does not know the car) */
    private pluggedCar(): PluggedCar | undefined {
        for (const slot of this.vehicleSlots()) {
            const plug = text(this.values.get(`ford.vehicle${slot}.plugStatus`)).toUpperCase();
            if (
                text(this.values.get(`ford.vehicle${slot}.engineType`)).toUpperCase() === 'BEV' &&
                plug &&
                plug !== 'DISCONNECTED'
            ) {
                return { slot, name: text(this.values.get(`ford.vehicle${slot}.name`)) };
            }
        }
        return undefined;
    }

    /**
     * Sends when the condition starts; the condition ending re-arms it.
     *
     * @param key - Entry in the memory
     * @param active - Condition holds now
     * @param message - Text, called only when sending
     * @param dropOld - Remove entries of the same kind from other days (keys with a date)
     */
    private once(key: string, active: boolean, message?: () => string, dropOld = false): void {
        const entry = this.sent[key];
        if (!active) {
            if (entry?.active) {
                entry.active = false;
                this.save();
            }
            return;
        }
        if (entry?.active || !message) {
            return;
        }
        if (dropOld) {
            const prefix = key.slice(0, key.lastIndexOf('.') + 1);
            for (const k of Object.keys(this.sent)) {
                if (k.startsWith(prefix) && k !== key) {
                    delete this.sent[k];
                }
            }
        }
        this.sent[key] = { at: this.host.now(), active: true };
        this.save();
        this.send(message());
    }

    private save(): void {
        void this.host.write(JSON.stringify(this.sent)).catch(() => undefined);
    }

    private send(message: string): void {
        this.queue = this.queue.then(async () => {
            try {
                await this.host.send(message);
                this.host.info(`Message sent: ${message}`);
            } catch (error) {
                this.host.warn(
                    `Message not sent (${error instanceof Error ? error.message : String(error)}): ${message}`,
                );
            }
        });
    }
}

/**
 * Instance that sends messages, like telegram.0. Empty means telegram.0.
 *
 * @param value - Value from the instance config
 * @returns The instance, undefined if the value is not an instance name
 */
export function notifyInstance(value: unknown): string | undefined {
    const instance = typeof value === 'string' ? value.trim().replace(/^system\.adapter\./, '') : '';
    if (!instance) {
        return 'telegram.0';
    }
    return /^[a-z0-9][a-z0-9_-]*\.\d{1,3}$/.test(instance) ? instance : undefined;
}

/**
 * Receivers, separated by commas. Empty: the instance sends to all of its users.
 *
 * @param value - Value from the instance config
 */
export function notifyUsers(value: unknown): string[] {
    const list = typeof value === 'string' ? value : '';
    return [
        ...new Set(
            list
                .split(',')
                .map(user => user.trim())
                .filter(Boolean),
        ),
    ];
}
