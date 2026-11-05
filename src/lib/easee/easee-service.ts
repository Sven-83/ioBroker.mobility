/*
 * Easee part of the adapter: finds the chargers of the account, polls their observations and
 * sends start/stop commands. Independent of the adapter class (everything comes in through
 * EaseeDeps), so the flow is unit-testable with fakes.
 *
 * Limits and behaviour:
 *  - observations: 100 requests / 5 min per account; 2 chargers every 60 s = 10 requests / 5 min
 *  - one poll at a time, chargers one after another; a small random offset per cycle
 *  - errors: exponential backoff up to 30 min, 429 waits at least Retry-After
 *  - rejected login: error log and stop (retrying could lock the account)
 *  - commands at most every 10 s per charger, values are read again 10 s and 40 s later
 *  - command choice like evcc: authorization required -> start/stop_charging,
 *    otherwise resume/pause_charging (sets the dynamic current, works without RFID)
 *  - with the SignalR stream up, values are pushed; REST then only runs every 5 min as a check,
 *    and the charger is subscribed again 15 s after a command (the stream can go silent then)
 *  - REST and pushed values are merged per observation ID, the newer timestamp wins
 *  - states are only written when their value changed
 */

import { describeError } from '../fuel/errors';
import type { Logger, TimerHandle } from '../fuel/fuel-service';
import type { ObjectDefinition } from '../fuel/objects';
import { FailureLog, formatDuration } from '../util/failure-log';
import type { EaseeConfig } from './config';
import type { ChargeCommand, ChargerInfo } from './easee-client';
import { EaseeAbortedError, EaseeAuthError, EaseeRateLimitedError } from './errors';
import { EASEE_ROOT, chargerChannel, chargerObjects, rootObjects } from './objects';
import {
    OP_MODE,
    OP_MODE_STATES,
    isCarConnected,
    parseChargerState,
    reasonText,
    type ChargerState,
    type RawObservation,
} from './observations';

/** Longest pause after repeated failures */
export const MAX_BACKOFF_MS = 30 * 60_000;
/** First retry after a failure of the charger list */
export const DISCOVERY_RETRY_MS = 60_000;
/** Without a selection, at most this many chargers are used automatically */
export const AUTO_SELECT_MAX = 2;
/** Retry when the account has no chargers */
export const NO_CHARGER_RETRY_MS = 60 * 60_000;
/** Minimum gap between two commands to the same charger */
export const COMMAND_GAP_MS = 10_000;
/** Re-reads after a command */
export const AFTER_COMMAND_POLLS_MS = [10_000, 40_000] as const;
/** The charge switch is not overwritten by polls for this long after a command */
export const COMMAND_SETTLE_MS = 60_000;
/** REST check interval while the stream is up */
export const STREAM_POLL_MS = 5 * 60_000;
/** Pushed values are collected this long before the states are written */
export const PUSH_APPLY_DELAY_MS = 1_000;
/** Resubscribe this long after a command */
export const RESUBSCRIBE_AFTER_COMMAND_MS = 15_000;

/** The part of the SignalR stream the service controls */
export interface StreamControl {
    /** Connects and subscribes the chargers */
    start(serials: string[]): void;
    /** Closes the stream */
    stop(): void;
    /** Subscribes one charger again */
    resubscribe(serial: string): void;
    /** Stream is up */
    isConnected(): boolean;
}

/** The part of the Easee client the service needs */
export interface EaseeApi {
    /** Chargers of the account */
    getChargers(): Promise<ChargerInfo[]>;
    /** Observations of one charger */
    getObservations(serial: string): Promise<RawObservation[]>;
    /** Charging command */
    command(serial: string, command: ChargeCommand): Promise<void>;
    /** Cancels running requests */
    abort(): void;
}

/** Everything the service needs from the outside */
export interface EaseeDeps {
    /** Easee client */
    client: EaseeApi;
    /** Adapter log */
    log: Logger;
    /** Current time (epoch ms) */
    now(): number;
    /** 0 <= value < 1 */
    random(): number;
    /** adapter.setTimeout */
    setTimeout(callback: () => void, ms: number): TimerHandle;
    /** adapter.clearTimeout */
    clearTimeout(handle: TimerHandle): void;
    /** Creates or updates objects */
    ensureObjects(definitions: ObjectDefinition[]): Promise<void>;
    /** Deletes charger channels whose slot is not in the list */
    removeChargersExcept(slots: number[]): Promise<void>;
    /** Writes a state with ack=true */
    setState(id: string, value: ioBroker.StateValue): Promise<void>;
    /** Connection status of the Easee part changed */
    onConnection(connected: boolean): void;
}

interface Charger {
    slot: number;
    serial: string;
    name: string;
    state: ChargerState | undefined;
    lastCommandAt: number;
    /** Newest observation per ID (REST and stream merged) */
    observations: Map<number, RawObservation>;
    /** Write of pushed values is scheduled */
    applyPending: boolean;
}

/**
 * Easee service for one validated config.
 */
export class EaseeService {
    private readonly failures = new FailureLog();
    private readonly timers = new Set<TimerHandle>();
    private chargers: Charger[] = [];
    private pollTimer: { handle: TimerHandle; at: number } | undefined;
    private polling = false;
    private pollAgain = false;
    private failureCount = 0;
    private stopped = false;
    private stream: StreamControl | undefined;
    /** Last written value per state ID (writes only on change) */
    private readonly written = new Map<string, ioBroker.StateValue>();

    /**
     * @param config - Validated Easee config (enabled)
     * @param deps - Dependencies
     */
    public constructor(
        private readonly config: EaseeConfig,
        private readonly deps: EaseeDeps,
    ) {}

    /**
     * Adds the real-time stream (optional; without it the service only polls).
     *
     * @param stream - SignalR stream
     */
    public attachStream(stream: StreamControl): void {
        this.stream = stream;
    }

    /**
     * A value pushed by the stream.
     *
     * @param serial - Serial number
     * @param observation - Observation
     */
    public pushObservation(serial: string, observation: RawObservation): void {
        const charger = this.chargers.find(c => c.serial === serial);
        if (!charger || this.stopped) {
            return;
        }
        merge(charger.observations, observation);
        if (!charger.applyPending) {
            charger.applyPending = true;
            this.schedule(() => {
                charger.applyPending = false;
                this.apply(charger).catch(error =>
                    this.deps.log.warn(`Easee: writing values failed: ${describeError(error)}`),
                );
            }, PUSH_APPLY_DELAY_MS);
        }
    }

    /**
     * The stream went up or down.
     *
     * @param connected - New state
     */
    public streamConnection(connected: boolean): void {
        if (this.stopped) {
            return;
        }
        this.write(`${EASEE_ROOT}.streamConnected`, connected).catch(() => undefined);
        if (!connected) {
            // back to normal polling while the stream is away
            this.requestPoll(this.config.intervalSec * 1000);
        }
    }

    /** Schedules the charger discovery shortly after the start */
    public start(): void {
        this.deps.log.info(`Easee: reading chargers every ${this.config.intervalSec} s`);
        this.schedule(() => void this.discover(), 2_000 + Math.floor(this.deps.random() * 5_000));
    }

    /** Stops timers and running requests */
    public stop(): void {
        this.stopped = true;
        for (const handle of this.timers) {
            this.deps.clearTimeout(handle);
        }
        this.timers.clear();
        this.pollTimer = undefined;
        this.stream?.stop();
        this.deps.client.abort();
    }

    /** Slots of the known chargers (for tests and the adapter) */
    public slots(): number[] {
        return this.chargers.map(charger => charger.slot);
    }

    /** Reads the charger list and creates the objects; retries itself */
    public async discover(): Promise<void> {
        if (this.stopped) {
            return;
        }
        const { log } = this.deps;
        let list: ChargerInfo[];
        try {
            list = await this.deps.client.getChargers();
        } catch (error) {
            const delay = this.handleFailure(error, DISCOVERY_RETRY_MS, 'charger list');
            if (delay !== undefined) {
                this.schedule(() => void this.discover(), delay);
            }
            return;
        }
        this.recovered();
        if (list.length === 0) {
            log.warn('Easee: no chargers in this account - next check in 1 h');
            this.schedule(() => void this.discover(), NO_CHARGER_RETRY_MS);
            return;
        }
        const selected = this.select(list);
        if (selected.length === 0) {
            // nothing usable selected: do not read or touch any charger (they may belong to others)
            return;
        }
        this.chargers = selected.map(({ slot, info }) => ({
            slot,
            serial: info.serial,
            name: info.name || `Charger ${slot}`,
            state: undefined,
            lastCommandAt: 0,
            observations: new Map<number, RawObservation>(),
            applyPending: false,
        }));
        const definitions = rootObjects();
        for (const charger of this.chargers) {
            definitions.push(...chargerObjects(charger.slot, charger.name, this.config.pricePerKwh > 0));
        }
        await this.deps.ensureObjects(definitions);
        await this.deps.removeChargersExcept(this.slots());
        for (const charger of this.chargers) {
            await this.write(`${chargerChannel(charger.slot)}.name`, charger.name);
        }
        log.info(
            `Easee: using ${this.chargers.map(c => `charger${c.slot} = "${c.name}"`).join(', ')}${
                list.length > this.chargers.length
                    ? ` (${list.length - this.chargers.length} other charger(s) ignored)`
                    : ''
            }`,
        );
        this.stream?.start(this.chargers.map(c => c.serial));
        await this.poll();
    }

    /**
     * Picks the chargers to use: the names from the settings (fixed slots), or - without a
     * selection - all chargers if there are at most AUTO_SELECT_MAX.
     *
     * @param list - All chargers of the account
     */
    private select(list: ChargerInfo[]): { slot: number; info: ChargerInfo }[] {
        const { log } = this.deps;
        const names = this.config.chargerNames;
        const available = (): string => list.map(c => `"${c.name}"`).join(', ');
        if (names.every(name => name === '')) {
            if (list.length <= AUTO_SELECT_MAX) {
                return list.map((info, index) => ({ slot: index + 1, info }));
            }
            log.warn(
                `Easee: this account sees ${list.length} chargers - please enter the names of yours in the ` +
                    `instance settings (Easee tab). Nothing is read or switched until then. Chargers: ${available()}`,
            );
            return [];
        }
        const result: { slot: number; info: ChargerInfo }[] = [];
        names.forEach((name, index) => {
            if (!name) {
                return;
            }
            const matches = list.filter(c => c.name.toLowerCase() === name.toLowerCase());
            if (matches.length === 1) {
                result.push({ slot: index + 1, info: matches[0] });
            } else if (matches.length > 1) {
                log.warn(`Easee: charger ${index + 1} "${name}" is not unique in this account - ignored`);
            } else {
                log.warn(`Easee: charger ${index + 1} "${name}" not found. Chargers: ${available()}`);
            }
        });
        return result;
    }

    /**
     * Reads the values again after the given delay (earlier timers win).
     *
     * @param delayMs - Delay in ms
     */
    public requestPoll(delayMs = 0): void {
        if (this.stopped || this.chargers.length === 0) {
            return;
        }
        const at = this.deps.now() + delayMs;
        if (this.pollTimer && this.pollTimer.at <= at) {
            return;
        }
        this.schedulePoll(delayMs);
    }

    /** One poll cycle over all chargers; schedules the next one itself */
    public async poll(): Promise<void> {
        if (this.stopped) {
            return;
        }
        if (this.polling) {
            this.pollAgain = true;
            return;
        }
        this.polling = true;
        const intervalMs = this.config.intervalSec * 1000;
        const normalMs = this.stream?.isConnected() ? Math.max(intervalMs, STREAM_POLL_MS) : intervalMs;
        let nextDelay: number | undefined = normalMs + Math.floor(this.deps.random() * 5_000);
        try {
            for (const charger of this.chargers) {
                for (const observation of await this.deps.client.getObservations(charger.serial)) {
                    merge(charger.observations, observation);
                }
                await this.apply(charger);
            }
            this.recovered();
        } catch (error) {
            nextDelay = this.handleFailure(error, intervalMs, 'reading values');
        } finally {
            this.polling = false;
        }
        if (nextDelay === undefined || this.stopped) {
            return;
        }
        if (this.pollAgain) {
            this.pollAgain = false;
            nextDelay = Math.min(nextDelay, 1_000);
        }
        this.requestPoll(nextDelay);
    }

    /**
     * Start (true) or stop (false) charging, triggered by a write to charger<N>.charge.
     *
     * @param slot - Charger slot
     * @param on - true = start/resume, false = stop/pause
     */
    public async setCharging(slot: number, on: boolean): Promise<void> {
        const { log } = this.deps;
        const charger = this.chargers.find(c => c.slot === slot);
        if (!charger || this.stopped) {
            log.warn(`Easee: charger ${slot} is not available, command ignored`);
            return;
        }
        const id = `${chargerChannel(slot)}.charge`;
        const now = this.deps.now();
        const st = charger.state;
        const actual = st?.opMode === OP_MODE.charging;

        if (now - charger.lastCommandAt < COMMAND_GAP_MS) {
            log.warn(`Easee: ${charger.name}: commands too fast, please wait a few seconds`);
            await this.write(id, actual);
            return;
        }
        if (on && (st?.opMode === OP_MODE.offline || st?.opMode === OP_MODE.disconnected || st?.online === false)) {
            log.warn(
                `Easee: ${charger.name}: cannot start - ${st?.online === false ? 'offline' : 'no car plugged in'}`,
            );
            await this.write(id, actual);
            return;
        }
        const command: ChargeCommand =
            st?.authorizationRequired === true
                ? on
                    ? 'start_charging'
                    : 'stop_charging'
                : on
                  ? 'resume_charging'
                  : 'pause_charging';

        charger.lastCommandAt = now;
        try {
            await this.deps.client.command(charger.serial, command);
            log.info(`Easee: ${charger.name}: ${command} sent`);
            await this.write(id, on);
            for (const delay of AFTER_COMMAND_POLLS_MS) {
                this.schedule(() => this.requestPoll(0), delay);
            }
            const stream = this.stream;
            if (stream) {
                this.schedule(() => stream.resubscribe(charger.serial), RESUBSCRIBE_AFTER_COMMAND_MS);
            }
        } catch (error) {
            if (error instanceof EaseeAbortedError) {
                return;
            }
            if (error instanceof EaseeAuthError) {
                this.handleFailure(error, 0, command);
            } else {
                log.warn(`Easee: ${charger.name}: ${command} failed: ${describeError(error)}`);
            }
            await this.write(id, actual);
        }
    }

    /**
     * Writes a state when its value changed.
     *
     * @param id - Relative state ID
     * @param value - Value
     */
    private async write(id: string, value: ioBroker.StateValue): Promise<void> {
        if (this.written.has(id) && this.written.get(id) === value) {
            return;
        }
        this.written.set(id, value);
        await this.deps.setState(id, value);
    }

    /**
     * Writes the states of one charger from its merged observations.
     *
     * @param charger - Charger
     */
    private async apply(charger: Charger): Promise<void> {
        const st = parseChargerState([...charger.observations.values()]);
        charger.state = st;
        const ch = chargerChannel(charger.slot);
        const set = async (key: string, value: ioBroker.StateValue | undefined): Promise<void> => {
            if (value !== null && value !== undefined) {
                await this.write(`${ch}.${key}`, value);
            }
        };
        await set('online', st.online);
        await set('opMode', st.opMode);
        await set('status', st.opMode === null ? null : OP_MODE_STATES[st.opMode]);
        await set('carConnected', isCarConnected(st.opMode));
        await set('charging', st.opMode === null ? null : st.opMode === OP_MODE.charging);
        await set('power', st.power);
        await set('sessionEnergy', st.sessionEnergy);
        await set('lifetimeEnergy', st.lifetimeEnergy);
        await set('dynamicCurrent', st.dynamicCurrent);
        await set('maxCurrent', st.maxCurrent);
        await set('outputCurrent', st.outputCurrent);
        await set('phaseMode', st.phaseMode);
        await set('cableLocked', st.cableLocked);
        await set('smartCharging', st.smartCharging);
        await set('authorizationRequired', st.authorizationRequired);
        await set('enabled', st.enabled);
        await set('reasonForNoCurrent', st.reasonForNoCurrent);
        await set('reasonText', reasonText(st.reasonForNoCurrent) || null);
        await set('errorCode', st.errorCode);
        await set('lastUpdate', st.latestPulse);
        if (this.config.pricePerKwh > 0 && st.sessionEnergy !== null) {
            await set('sessionCost', Math.round(st.sessionEnergy * this.config.pricePerKwh * 100) / 100);
        }
        if (st.opMode !== null && this.deps.now() - charger.lastCommandAt >= COMMAND_SETTLE_MS) {
            await set('charge', st.opMode === OP_MODE.charging);
        }
    }

    /**
     * Logs a failure and computes the retry delay.
     *
     * @param error - Thrown error
     * @param baseMs - Normal delay of the failed action
     * @param what - Short description for the log
     * @returns Delay before the next try, undefined = do not retry
     */
    private handleFailure(error: unknown, baseMs: number, what: string): number | undefined {
        if (error instanceof EaseeAbortedError || this.stopped) {
            return undefined;
        }
        this.deps.onConnection(false);
        if (error instanceof EaseeAuthError) {
            this.deps.log.error(
                `Easee: ${describeError(error)} - Easee stopped, please check the login in the instance settings`,
            );
            this.stop();
            return undefined;
        }
        this.failureCount++;
        let delay = Math.min(Math.max(baseMs, 1_000) * 2 ** (this.failureCount - 1), MAX_BACKOFF_MS);
        if (error instanceof EaseeRateLimitedError) {
            delay = Math.max(delay, error.waitMs);
        }
        const level = this.failures.failed(this.deps.now());
        this.deps.log[level](`Easee: ${what} failed: ${describeError(error)}; next try in ${formatDuration(delay)}`);
        return delay;
    }

    /** Resets the backoff after a success */
    private recovered(): void {
        this.failureCount = 0;
        const outage = this.failures.recovered(this.deps.now());
        if (outage !== undefined) {
            this.deps.log.info(`Easee reachable again (outage ${formatDuration(outage)})`);
        }
        this.deps.onConnection(true);
    }

    /**
     * Replaces the pending poll timer.
     *
     * @param delayMs - Delay in ms
     */
    private schedulePoll(delayMs: number): void {
        if (this.pollTimer) {
            this.deps.clearTimeout(this.pollTimer.handle);
            this.timers.delete(this.pollTimer.handle);
        }
        const at = this.deps.now() + delayMs;
        const handle = this.schedule(() => {
            this.pollTimer = undefined;
            void this.poll();
        }, delayMs);
        this.pollTimer = { handle, at };
    }

    /**
     * @param callback - Work
     * @param ms - Delay
     */
    private schedule(callback: () => void, ms: number): TimerHandle {
        const handle = this.deps.setTimeout(() => {
            this.timers.delete(handle);
            if (!this.stopped) {
                callback();
            }
        }, ms);
        this.timers.add(handle);
        return handle;
    }
}

/**
 * Keeps the newer of two observations with the same ID.
 *
 * @param map - Observations of one charger
 * @param observation - New observation
 */
export function merge(map: Map<number, RawObservation>, observation: RawObservation): void {
    const old = map.get(observation.id);
    if (old && Date.parse(observation.timestamp) < Date.parse(old.timestamp)) {
        return; // an older REST answer must not overwrite a newer pushed value
    }
    map.set(observation.id, observation);
}
