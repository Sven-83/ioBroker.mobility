/*
 * ioBroker.mobility - Ford vehicles (FordConnect Query), Easee chargers and fuel prices (Tankerkoenig).
 * Each part lives in its own folder under src/lib; this class only wires them to the adapter.
 * Parts: fuel prices, Easee chargers, Ford vehicles.
 */

import * as utils from '@iobroker/adapter-core';
import { randomBytes } from 'node:crypto';
import { readEaseeConfig } from './lib/easee/config';
import { EaseeClient } from './lib/easee/easee-client';
import { EaseeService } from './lib/easee/easee-service';
import { EaseeSessions } from './lib/easee/sessions-sync';
import { EaseeStream, type SocketLike } from './lib/easee/stream';
import { EASEE_ROOT, parseChargerCommandId } from './lib/easee/objects';
import { readFordConfig } from './lib/ford/config';
import { FordClient, type FordToken } from './lib/ford/ford-client';
import { FordService } from './lib/ford/ford-service';
import { parseVehicleCommandId, vehicleChannel } from './lib/ford/objects';
import { readFuelConfig } from './lib/fuel/config';
import { FuelService } from './lib/fuel/fuel-service';
import { FUEL_ROOT, type ObjectDefinition } from './lib/fuel/objects';
import { TankerkoenigClient } from './lib/fuel/tankerkoenig';
import { NOTIFY_STATE, Notifier, notifyInstance, notifyUsers, type MessageKind } from './lib/notify/notifier';

/** Longest wait for an answer of the messenger */
const NOTIFY_TIMEOUT_MS = 15_000;

/** File in the instance file storage that holds the 7-day price memory */
const FUEL_HISTORY_FILE = 'fuel-history.json';

class Mobility extends utils.Adapter {
    private fuel: FuelService | undefined;
    private easee: EaseeService | undefined;
    private ford: FordService | undefined;
    private notifier: Notifier | undefined;
    /** Connection state per running part; info.connection = all running parts connected */
    private readonly connections = new Map<string, boolean>();
    /** Last value written to info.connection (written only on change) */
    private connectionWritten: boolean | undefined;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'mobility',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        await this.setState('info.connection', false, true);
        this.connectionWritten = false;
        await this.startNotifier();
        await this.startFuel();
        await this.startEasee();
        await this.startFord();
        if (!this.fuel && !this.easee && !this.ford) {
            this.log.info(
                'Nothing configured yet - enter fuel price, Easee and/or Ford settings in the instance settings',
            );
        }
    }

    /**
     * Writes a state with ack and lets the notifier read along.
     *
     * @param id - Relative state ID
     * @param value - Value
     */
    private async write(id: string, value: ioBroker.StateValue): Promise<void> {
        await this.setState(id, value, true);
        this.notifier?.observe(id, value);
    }

    /** Starts the messages (Telegram) if they are switched on */
    private async startNotifier(): Promise<void> {
        const native = this.config as unknown as Record<string, unknown>;
        if (native.notifyEnabled !== true) {
            return;
        }
        const kinds = new Set<MessageKind>();
        // notifyFull is off unless set; the others are on unless switched off
        if (native.notifyFull === true) {
            kinds.add('full');
        }
        for (const [field, kind] of [
            ['notifyFuel', 'fuel'],
            ['notifyCharge', 'charge'],
            ['notifyPlug', 'plug'],
            ['notifyTyres', 'tyres'],
        ] as const) {
            if (native[field] !== false) {
                kinds.add(kind);
            }
        }
        const german = await this.isGerman();
        this.notifier = new Notifier(
            {
                send: text => this.notify(text, native.notifyInstance, native.notifyUsers),
                read: async () => (await this.getStateAsync(NOTIFY_STATE))?.val ?? undefined,
                write: value => this.setState(NOTIFY_STATE, value, true),
                now: () => Date.now(),
                info: message => this.log.info(message),
                warn: message => this.log.warn(message),
            },
            { kinds, german },
        );
        await this.notifier.start();
        this.log.info(
            `Messages: ${[...kinds].join(', ') || 'none'} via ${notifyInstance(native.notifyInstance) ?? '?'}`,
        );
    }

    /** Language of the system is German */
    private async isGerman(): Promise<boolean> {
        try {
            const config = await this.getForeignObjectAsync('system.config');
            return config?.common?.language === 'de';
        } catch {
            return false;
        }
    }

    /**
     * Sends a message through a messenger instance (telegram.0 by default). Text only.
     *
     * @param text - Message
     * @param instanceValue - Instance from the config
     * @param usersValue - Receivers from the config, empty for all
     */
    private async notify(text: string, instanceValue: unknown, usersValue: unknown): Promise<void> {
        const instance = notifyInstance(instanceValue);
        if (!instance) {
            throw new Error('the instance for messages is not valid (example: telegram.0)');
        }
        if (!(await this.getForeignStateAsync(`system.adapter.${instance}.alive`))?.val) {
            throw new Error(`${instance} is not running`);
        }
        const users = notifyUsers(usersValue);
        for (const user of users.length > 0 ? users : [undefined]) {
            const answer: unknown = await this.sendToAsync(instance, 'send', user ? { text, user } : { text }, {
                timeout: NOTIFY_TIMEOUT_MS,
            });
            if (answer && typeof answer === 'object' && 'error' in answer && answer.error) {
                throw new Error(`${instance}: ${typeof answer.error === 'string' ? answer.error : 'error'}`);
            }
            // telegram answers with the number of messages sent: 0 means it knows no receiver
            if (answer === 0) {
                throw new Error(
                    `${instance} sent the message to nobody${user ? ` (receiver "${user}" unknown?)` : ''}`,
                );
            }
        }
    }

    /**
     * Button "send a test message" in the instance settings.
     *
     * @param obj - Message from the admin
     */
    private onMessage(obj: ioBroker.Message): void {
        if (obj?.command !== 'notifyTest' || !obj.callback) {
            return;
        }
        const data = (obj.message ?? {}) as Record<string, unknown>;
        void (async () => {
            const german = await this.isGerman();
            const text = german
                ? 'mobility: Testnachricht. Meldungen zu Tanken, Laden und Reifen kommen hier an.'
                : 'mobility: test message. Messages about fuel, charging and tyres arrive here.';
            try {
                await this.notify(text, data.instance, data.users);
                this.sendTo(obj.from, obj.command, { result: german ? 'Gesendet' : 'Sent' }, obj.callback);
            } catch (error) {
                this.sendTo(obj.from, obj.command, { error: (error as Error).message }, obj.callback);
            }
        })();
    }

    /** Validates the fuel config and starts the fuel service if it is complete */
    private async startFuel(): Promise<void> {
        const { config, problems } = readFuelConfig(this.config);
        for (const problem of problems) {
            this.log.warn(`Fuel prices: ${problem}`);
        }
        if (!config.enabled) {
            if (this.config.fuelEnabled !== false && (config.apiKey || config.stations.length > 0)) {
                this.log.warn('Fuel prices: API key or stations missing - fuel prices stay off');
            }
            return;
        }

        // meta object for the instance file storage (7-day price memory)
        await this.setForeignObjectNotExistsAsync(this.namespace, {
            type: 'meta',
            common: { name: 'mobility data files', type: 'meta.user' },
            native: {},
        });

        const client = new TankerkoenigClient(config.apiKey);
        this.fuel = new FuelService(config, {
            client,
            log: this.log,
            now: () => Date.now(),
            random: () => Math.random(),
            setTimeout: (callback, ms) => this.setTimeout(callback, ms),
            clearTimeout: handle => this.clearTimeout(handle as ioBroker.Timeout | undefined),
            ensureObjects: definitions => this.ensureObjects(definitions),
            removeStationsExcept: slots =>
                this.removeChannelsExcept(`${FUEL_ROOT}.station`, slots, 'Fuel prices', true),
            setState: (id, value) => this.write(id, value),
            loadHistory: async () => {
                try {
                    const { file } = await this.readFileAsync(this.namespace, FUEL_HISTORY_FILE);
                    return file.toString();
                } catch {
                    return undefined; // first start
                }
            },
            saveHistory: text => this.writeFileAsync(this.namespace, FUEL_HISTORY_FILE, text),
            onConnection: connected => this.setConnection('fuel', connected),
        });
        await this.fuel.start();
    }

    /** Validates the Easee config and starts the Easee service if it is complete */
    private async startEasee(): Promise<void> {
        const { config, problems } = readEaseeConfig(this.config);
        for (const problem of problems) {
            this.log.warn(`Easee: ${problem}`);
        }
        if (!config.enabled) {
            return;
        }
        const client = new EaseeClient(config.userName, config.password);
        this.easee = new EaseeService(config, {
            client,
            log: this.log,
            now: () => Date.now(),
            random: () => Math.random(),
            setTimeout: (callback, ms) => this.setTimeout(callback, ms),
            clearTimeout: handle => this.clearTimeout(handle as ioBroker.Timeout | undefined),
            ensureObjects: definitions => this.ensureObjects(definitions),
            removeChargersExcept: slots => this.removeChannelsExcept(`${EASEE_ROOT}.charger`, slots, 'Easee', false),
            setState: (id, value) => this.write(id, value),
            onConnection: connected => this.setConnection('easee', connected),
        });
        if (config.stream) {
            const service = this.easee;
            service.attachStream(
                new EaseeStream({
                    getToken: () => client.accessToken(),
                    createSocket: (url, headers) => new WebSocket(url, { headers }) as unknown as SocketLike,
                    fetch: (input, init) => fetch(input, init),
                    log: this.log,
                    now: () => Date.now(),
                    setTimeout: (callback, ms) => this.setTimeout(callback, ms),
                    clearTimeout: handle => this.clearTimeout(handle as ioBroker.Timeout | undefined),
                    onObservation: (serial, observation) => service.pushObservation(serial, observation),
                    onConnection: connected => service.streamConnection(connected),
                }),
            );
        }
        this.easee.attachSessions(
            new EaseeSessions(
                config.pricePerKwh,
                {
                    getSessions: (serial, from, to) => client.getSessions(serial, from, to),
                    log: this.log,
                    now: () => Date.now(),
                    setTimeout: (callback, ms) => this.setTimeout(callback, ms),
                    clearTimeout: handle => this.clearTimeout(handle as ioBroker.Timeout | undefined),
                    ensureObjects: definitions => this.ensureObjects(definitions),
                    setState: (id, value) => this.write(id, value),
                    load: async slot => {
                        try {
                            const { file } = await this.readFileAsync(this.namespace, `easee-sessions-${slot}.json`);
                            return file.toString();
                        } catch {
                            return undefined; // first start
                        }
                    },
                    save: (slot, text) => this.writeFileAsync(this.namespace, `easee-sessions-${slot}.json`, text),
                },
                config.sessionsFrom,
            ),
        );
        await this.subscribeStatesAsync(`${EASEE_ROOT}.charger*.charge`);
        await this.subscribeStatesAsync(`${EASEE_ROOT}.charger*.refresh`);
        this.easee.start();
    }

    /** Validates the Ford config and starts the Ford service if it is complete */
    private async startFord(): Promise<void> {
        const { config, problems } = readFordConfig(this.config);
        for (const problem of problems) {
            this.log.warn(`Ford: ${problem}`);
        }
        if (!config.enabled) {
            return;
        }
        this.ford = new FordService(config, {
            createClient: slot =>
                new FordClient(config.clientId, config.clientSecret, config.redirectUri, {
                    load: () => this.loadFordToken(slot),
                    save: token => this.saveFordToken(slot, token),
                }),
            log: this.log,
            now: () => Date.now(),
            random: () => Math.random(),
            randomState: () => randomBytes(8).toString('hex'),
            setTimeout: (callback, ms) => this.setTimeout(callback, ms),
            clearTimeout: handle => this.clearTimeout(handle as ioBroker.Timeout | undefined),
            ensureObjects: definitions => this.ensureObjects(definitions),
            setState: (id, value) => this.write(id, value),
            onConnection: connected => this.setConnection('ford', connected),
            loadHistory: async slot => {
                try {
                    const { file } = await this.readFileAsync(this.namespace, `ford-history-${slot}.json`);
                    return file.toString();
                } catch {
                    return undefined; // first start
                }
            },
            saveHistory: (slot, text) => this.writeFileAsync(this.namespace, `ford-history-${slot}.json`, text),
        });
        await this.subscribeStatesAsync('ford.vehicle*.login.response');
        await this.subscribeStatesAsync('ford.vehicle*.refresh');
        await this.ford.start();
    }

    /**
     * Ford token of one vehicle, stored encrypted (system secret) in ford.vehicleN.login.token.
     *
     * @param slot - Vehicle slot
     */
    private async loadFordToken(slot: number): Promise<FordToken | undefined> {
        const state = await this.getStateAsync(`${vehicleChannel(slot)}.login.token`);
        if (typeof state?.val !== 'string' || state.val === '') {
            return undefined;
        }
        try {
            const token = JSON.parse(this.decrypt(state.val)) as FordToken;
            return typeof token.access === 'string' && typeof token.refresh === 'string' ? token : undefined;
        } catch {
            this.log.warn(`Ford: stored login of vehicle ${slot} could not be read - please log in again`);
            return undefined;
        }
    }

    /**
     * @param slot - Vehicle slot
     * @param token - Token, undefined = forget
     */
    private async saveFordToken(slot: number, token: FordToken | undefined): Promise<void> {
        await this.setState(
            `${vehicleChannel(slot)}.login.token`,
            token ? this.encrypt(JSON.stringify(token)) : '',
            true,
        );
    }

    /**
     * Commands from VIS / scripts (only writes with ack=false).
     *
     * @param id - Full state ID
     * @param state - New state
     */
    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (!state || state.ack) {
            return;
        }
        const vehicle = parseVehicleCommandId(this.namespace, id);
        if (vehicle && this.ford) {
            if (vehicle.command === 'refresh') {
                this.ford.requestPoll(vehicle.slot);
            } else {
                void this.ford.handleLoginResponse(vehicle.slot, typeof state.val === 'string' ? state.val : '');
            }
            return;
        }
        if (!this.easee) {
            return;
        }
        const target = parseChargerCommandId(this.namespace, id);
        if (!target) {
            return;
        }
        if (target.command === 'refresh') {
            this.easee.requestPoll(0);
            return;
        }
        if (typeof state.val !== 'boolean') {
            this.log.warn(`Easee: ${id} expects true or false`);
            return;
        }
        void this.easee.setCharging(target.slot, state.val);
    }

    /**
     * @param part - fuel / easee
     * @param connected - Connection state of that part
     */
    private setConnection(part: string, connected: boolean): void {
        this.connections.set(part, connected);
        const all = [...this.connections.values()].every(Boolean);
        if (all !== this.connectionWritten) {
            this.connectionWritten = all;
            void this.setState('info.connection', all, true);
        }
    }

    /**
     * Creates or updates objects (names may change in the config).
     *
     * @param definitions - Objects relative to the namespace
     */
    private async ensureObjects(definitions: ObjectDefinition[]): Promise<void> {
        for (const definition of definitions) {
            await this.extendObject(definition.id, definition.obj);
        }
    }

    /**
     * Handles numbered channels (fuel stations, chargers) whose slot is no longer in use.
     * Rule of the owner (2026-11-05): nothing that has to do with Easee is ever deleted - those
     * channels stay and the log only says where they are. Fuel station channels may be removed.
     *
     * @param relativePrefix - e.g. "fuel.station" or "easee.charger"
     * @param slots - Slots that are still in use
     * @param part - Name for the log
     * @param mayDelete - true only for the fuel part
     */
    private async removeChannelsExcept(
        relativePrefix: string,
        slots: number[],
        part: string,
        mayDelete: boolean,
    ): Promise<void> {
        const prefix = `${this.namespace}.${relativePrefix}`;
        const channels = await this.getForeignObjectsAsync(`${prefix}*`, 'channel');
        for (const id of Object.keys(channels)) {
            const slot = Number(id.slice(prefix.length));
            if (!Number.isInteger(slot) || slots.includes(slot)) {
                continue;
            }
            if (mayDelete) {
                this.log.info(`${part}: removing ${id} (no longer in use)`);
                await this.delForeignObjectAsync(id, { recursive: true });
            } else {
                this.log.info(`${part}: ${id} is no longer in use - kept (Easee objects are never deleted)`);
            }
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param callback - Callback function
     */
    private onUnload(callback: () => void): void {
        try {
            this.fuel?.stop();
            this.easee?.stop();
            this.ford?.stop();
            void this.setState('info.connection', false, true);
            callback();
        } catch (error) {
            this.log.error(`Error during unloading: ${(error as Error).message}`);
            callback();
        }
    }
}
if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Mobility(options);
} else {
    // otherwise start the instance directly
    (() => new Mobility())();
}
