/*
 * Fuel price part of the adapter: polls prices.php, keeps the own 7-day memory, rates the
 * current price and writes the states. Independent of the adapter class (everything comes in
 * through FuelDeps), so the whole flow is unit-testable with fakes.
 *
 * Timing rules (Tankerkoenig terms, see tankerkoenig.ts):
 *  - interval >= 5 min plus a random 0-59 s offset (no round times), first run 5-65 s after start
 *  - never two requests within 61 s (prices and the daily detail requests share one gate)
 *  - master data (detail.php) once per station and day
 */

import type { FuelConfig } from './config';
import {
    FuelAbortedError,
    FuelKeyRejectedError,
    FuelRateLimitedError,
    FuelRefusedError,
    describeError,
} from './errors';
import { FUEL_ROOT, rootObjects, stationChannel, stationObjects, type ObjectDefinition } from './objects';
import { PriceHistory } from './price-history';
import { evaluate } from './rating';
import type { StationDetail, StationPrices } from './tankerkoenig';
import { FailureLog, formatDuration } from '../util/failure-log';

/** Only Super E10 is tracked (decision 2026-11-05); also the key suffix in the price memory */
export const FUEL = 'e10';

/** Minimum gap between two requests (API: at most one per minute) */
export const REQUEST_GAP_MS = 61_000;
/** Longest pause after repeated failures */
export const MAX_BACKOFF_MS = 60 * 60_000;
/** Pause after an ok:false answer (the terms say: no further requests) */
export const REFUSED_PAUSE_MS = 60 * 60_000;
/** Master data is refreshed after this time */
export const DETAIL_MAX_AGE_MS = 24 * 3_600_000;

/** The part of the Tankerkoenig client the service needs */
export interface FuelClient {
    /** Current prices (prices.php) */
    getPrices(stationIds: string[]): Promise<Map<string, StationPrices>>;
    /** Master data (detail.php) */
    getDetail(stationId: string): Promise<StationDetail>;
    /** Cancels running requests */
    abort(): void;
}

/** Logger subset */
export interface Logger {
    /** Error */
    error(message: string): void;
    /** Warning */
    warn(message: string): void;
    /** Info */
    info(message: string): void;
    /** Debug */
    debug(message: string): void;
}

/** Timer handle as returned by adapter.setTimeout */
export type TimerHandle = unknown;

/** Everything the service needs from the outside */
export interface FuelDeps {
    /** Tankerkoenig client */
    client: FuelClient;
    /** Adapter log */
    log: Logger;
    /** Current time (epoch ms) */
    now(): number;
    /** 0 <= value < 1 */
    random(): number;
    /** adapter.setTimeout (cleared on unload) */
    setTimeout(callback: () => void, ms: number): TimerHandle;
    /** adapter.clearTimeout */
    clearTimeout(handle: TimerHandle): void;
    /** Creates or updates objects (extendObject semantics) */
    ensureObjects(definitions: ObjectDefinition[]): Promise<void>;
    /** Deletes station channels whose slot is not in the list (station removed in the config) */
    removeStationsExcept(slots: number[]): Promise<void>;
    /** Writes a state with ack=true */
    setState(id: string, value: ioBroker.StateValue): Promise<void>;
    /** Reads / writes the 7-day memory file */
    loadHistory(): Promise<string | undefined>;
    /** Writes the 7-day memory file */
    saveHistory(text: string): Promise<void>;
    /** Connection status of the fuel part changed */
    onConnection(connected: boolean): void;
}

/**
 * Fuel price service for one validated config.
 */
export class FuelService {
    private history = new PriceHistory();
    private readonly failures = new FailureLog();
    private readonly timers = new Set<TimerHandle>();
    private readonly detailFetched = new Map<string, number>();
    private readonly missingReported = new Set<string>();
    private nextRequestAt = 0;
    private failureCount = 0;
    private stopped = false;

    /**
     * @param config - Validated fuel config (enabled)
     * @param deps - Dependencies
     */
    public constructor(
        private readonly config: FuelConfig,
        private readonly deps: FuelDeps,
    ) {}

    /** Creates the objects, loads the memory and schedules the first poll */
    public async start(): Promise<void> {
        const { log } = this.deps;
        const loaded = PriceHistory.parse(await this.deps.loadHistory().catch(() => undefined));
        if (!loaded.valid) {
            log.warn('Fuel price memory could not be read, starting with an empty 7-day history');
        }
        this.history = loaded.history;

        const definitions = rootObjects();
        for (const station of this.config.stations) {
            definitions.push(...stationObjects(station.slot, station.name));
        }
        await this.deps.ensureObjects(definitions);
        await this.deps.removeStationsExcept(this.config.stations.map(station => station.slot));
        for (const station of this.config.stations) {
            await this.deps.setState(`${stationChannel(station.slot)}.name`, station.name);
        }

        const firstDelay = 5_000 + Math.floor(this.deps.random() * 60_000);
        log.info(
            `Fuel prices: ${this.config.stations.length} station(s), every ${this.config.intervalMin} min, ` +
                `Super E10; first request in ${Math.round(firstDelay / 1000)} s`,
        );
        this.schedule(() => void this.pollPrices(), firstDelay);
    }

    /** Stops timers and running requests (adapter unload / config change) */
    public stop(): void {
        this.stopped = true;
        for (const handle of this.timers) {
            this.deps.clearTimeout(handle);
        }
        this.timers.clear();
        this.deps.client.abort();
    }

    /** One price cycle; schedules the next one itself */
    public async pollPrices(): Promise<void> {
        if (this.stopped) {
            return;
        }
        const { log } = this.deps;
        const intervalMs = this.config.intervalMin * 60_000;
        let nextDelay = intervalMs;
        try {
            await this.gate();
            const prices = await this.deps.client.getPrices(this.config.stations.map(station => station.id));
            await this.applyPrices(prices);
            this.failureCount = 0;
            const outage = this.failures.recovered(this.deps.now());
            if (outage !== undefined) {
                log.info(`Tankerkoenig reachable again (outage ${formatDuration(outage)})`);
            }
            this.deps.onConnection(true);
            this.scheduleDetails();
        } catch (error) {
            if (error instanceof FuelAbortedError || this.stopped) {
                return;
            }
            this.deps.onConnection(false);
            if (error instanceof FuelKeyRejectedError) {
                log.error(
                    `${describeError(error)} - fuel prices stopped, please check the key in the instance settings`,
                );
                return;
            }
            this.failureCount++;
            nextDelay = Math.min(intervalMs * 2 ** (this.failureCount - 1), Math.max(MAX_BACKOFF_MS, intervalMs));
            if (error instanceof FuelRateLimitedError) {
                nextDelay = Math.max(nextDelay, error.waitMs);
            }
            if (error instanceof FuelRefusedError) {
                nextDelay = Math.max(nextDelay, REFUSED_PAUSE_MS);
                this.pause(REFUSED_PAUSE_MS);
            }
            const level = this.failures.failed(this.deps.now());
            log[level](`Fuel prices: ${describeError(error)}; next try in ${formatDuration(nextDelay)}`);
        }
        this.schedule(() => void this.pollPrices(), nextDelay + Math.floor(this.deps.random() * 60_000));
    }

    /**
     * Writes prices, memory and ratings.
     *
     * @param prices - Answer of prices.php
     */
    private async applyPrices(prices: Map<string, StationPrices>): Promise<void> {
        const now = this.deps.now();
        const ranking: { station: string; name: string; price: number; rating: string }[] = [];

        for (const station of this.config.stations) {
            const ch = stationChannel(station.slot);
            const entry = prices.get(station.id);
            if (!entry) {
                if (!this.missingReported.has(station.id)) {
                    this.missingReported.add(station.id);
                    this.deps.log.warn(
                        `Fuel prices: station "${station.name}" is unknown to Tankerkoenig, check its ID`,
                    );
                }
                await this.deps.setState(`${ch}.status`, 'not found');
                await this.deps.setState(`${ch}.open`, false);
                continue;
            }
            const open = entry.status === 'open';
            await this.deps.setState(`${ch}.status`, entry.status);
            await this.deps.setState(`${ch}.open`, open);
            await this.deps.setState(`${ch}.lastUpdate`, now);

            const current = open ? entry.e10 : null;
            await this.deps.setState(`${ch}.e10`, current);
            const key = PriceHistory.key(station.id, FUEL);
            this.history.add(key, now, current);
            const result = evaluate(this.history.points(key), current, now);
            await this.deps.setState(`${ch}.rating`, result.rating);
            await this.deps.setState(`${ch}.rank`, result.rank === null ? null : Math.round(result.rank * 100));
            await this.deps.setState(`${ch}.min7d`, result.min);
            await this.deps.setState(`${ch}.max7d`, result.max);
            await this.deps.setState(`${ch}.avg7d`, result.average);
            await this.deps.setState(`${ch}.coverage`, Math.round(result.coverageMs / 360_000) / 10);
            await this.deps.setState(`${ch}.bestHour`, result.bestHour);
            await this.deps.setState(`${ch}.bestHourPrice`, result.bestHourPrice);
            await this.deps.setState(`${ch}.bestWeekday`, result.bestWeekday);
            await this.deps.setState(`${ch}.bestWeekdayPrice`, result.bestWeekdayPrice);

            if (current !== null) {
                ranking.push({
                    station: `station${station.slot}`,
                    name: station.name,
                    price: current,
                    rating: result.rating,
                });
            }
        }

        ranking.sort((a, b) => a.price - b.price);
        await this.deps.setState(`${FUEL_ROOT}.ranking`, JSON.stringify(ranking));
        await this.deps.setState(`${FUEL_ROOT}.cheapestStation`, ranking[0]?.name ?? '');
        await this.deps.setState(`${FUEL_ROOT}.cheapestPrice`, ranking[0]?.price ?? null);

        const keep = new Set(this.config.stations.map(station => PriceHistory.key(station.id, FUEL)));
        this.history.prune(now, keep);
        await this.deps.saveHistory(this.history.serialize()).catch(error => {
            this.deps.log.warn(`Fuel price memory could not be saved: ${describeError(error)}`);
        });
    }

    /** Fetches master data of the next station that needs it (one per gate slot) */
    private scheduleDetails(): void {
        const now = this.deps.now();
        const due = this.config.stations.findIndex(station => {
            const last = this.detailFetched.get(station.id);
            return last === undefined || now - last > DETAIL_MAX_AGE_MS;
        });
        if (due === -1) {
            return;
        }
        this.schedule(() => void this.fetchDetail(due), 0);
    }

    /**
     * @param index - 0-based position in config.stations
     */
    private async fetchDetail(index: number): Promise<void> {
        const station = this.config.stations[index];
        if (this.stopped || !station) {
            return;
        }
        // mark first so a failing station does not block the others until tomorrow's retry
        this.detailFetched.set(station.id, this.deps.now());
        try {
            await this.gate();
            const detail = await this.deps.client.getDetail(station.id);
            const ch = stationChannel(station.slot);
            await this.deps.setState(`${ch}.brand`, detail.brand);
            const street = [detail.street, detail.houseNumber].filter(Boolean).join(' ');
            const place = [detail.postCode, detail.place].filter(Boolean).join(' ');
            await this.deps.setState(`${ch}.address`, [street, place].filter(Boolean).join(', '));
        } catch (error) {
            if (error instanceof FuelAbortedError || this.stopped) {
                return;
            }
            if (error instanceof FuelRefusedError) {
                this.pause(REFUSED_PAUSE_MS);
                this.deps.log.warn(`Fuel prices: ${describeError(error)}; no requests for 1 h`);
                return;
            }
            this.deps.log.debug(`Fuel prices: master data of "${station.name}" failed: ${describeError(error)}`);
        }
        this.scheduleDetails();
    }

    /** Waits until the next request slot (reservation, so parallel callers queue up) */
    /**
     * Blocks all requests (prices and master data) for a while.
     *
     * @param ms - Pause in ms
     */
    private pause(ms: number): void {
        this.nextRequestAt = Math.max(this.nextRequestAt, this.deps.now() + ms);
    }

    private async gate(): Promise<void> {
        const now = this.deps.now();
        const slot = Math.max(now, this.nextRequestAt);
        this.nextRequestAt = slot + REQUEST_GAP_MS;
        const wait = slot - now;
        if (wait > 0) {
            await new Promise<void>(resolve => this.schedule(resolve, wait));
        }
        if (this.stopped) {
            throw new FuelAbortedError('stopped');
        }
    }

    /**
     * @param callback - Function to run
     * @param ms - Delay
     */
    private schedule(callback: () => void, ms: number): void {
        if (this.stopped) {
            return;
        }
        const handle = this.deps.setTimeout(() => {
            this.timers.delete(handle);
            callback();
        }, ms);
        this.timers.add(handle);
    }
}
