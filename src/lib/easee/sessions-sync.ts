/*
 * Downloads the charging sessions of the selected chargers and writes the cost states.
 *
 *  - first start: back in steps of one year until a year without sessions, 2016 or the
 *    configured start date ("sessions from"); older sessions are neither read nor counted
 *  - then: last 30 days every 6 h, and 2 min after a car was unplugged
 *  - at most one sessions request every 6 min for the whole account (Easee allows about 10 per
 *    hour), requests one after another
 *  - errors: backoff up to 6 h, 429 waits at least Retry-After, rejected login = stop
 *  - one file per charger (easee-sessions-N.json); sessions are never removed
 */

import { describeError } from '../fuel/errors';
import type { Logger, TimerHandle } from '../fuel/fuel-service';
import type { ObjectDefinition } from '../fuel/objects';
import { EaseeAbortedError, EaseeAuthError, EaseeRateLimitedError } from './errors';
import { EASEE_ROOT, chargerChannel, historyObjects } from './objects';
import { SessionReport, SessionStore, type ChargeSession } from './sessions';

const DAY = 86_400_000;
/** Gap between two sessions requests (account wide) */
export const REQUEST_GAP_MS = 6 * 60_000;
/** First request after the start */
export const FIRST_REQUEST_MS = 60_000;
/** Regular update */
export const REFRESH_MS = 6 * 3_600_000;
/** Update after the car was unplugged (Easee closes the session) */
export const AFTER_UNPLUG_MS = 2 * 60_000;
/** Window of one backfill step */
export const BACKFILL_WINDOW_MS = 365 * DAY;
/** Window of the regular update */
export const RECENT_WINDOW_MS = 30 * DAY;
/** Backfill never goes before this (Easee chargers exist since about 2018) */
export const BACKFILL_LIMIT = Date.UTC(2016, 0, 1);
/** Longest backoff */
export const MAX_BACKOFF_MS = 6 * 3_600_000;
/** Weeks / months in the JSON states */
export const DAYS = 14;
export const WEEKS = 12;
export const MONTHS = 13;

/** A charger the sessions are read for */
export interface SessionCharger {
    /** 1-based slot */
    slot: number;
    /** Serial number */
    serial: string;
    /** Name from the Easee app */
    name: string;
}

/** What the Easee service calls */
export interface SessionControl {
    /** Chargers known (after discovery) */
    start(chargers: SessionCharger[]): Promise<void>;
    /** The car of a charger was unplugged */
    carUnplugged(slot: number): void;
    /** Stops timers */
    stop(): void;
}

/** Everything from the outside */
export interface SessionDeps {
    /** Sessions of one charger between two times */
    getSessions(serial: string, from: number, to: number): Promise<ChargeSession[]>;
    /** Adapter log */
    log: Logger;
    /** Current time (epoch ms) */
    now(): number;
    /** adapter.setTimeout */
    setTimeout(callback: () => void, ms: number): TimerHandle;
    /** adapter.clearTimeout */
    clearTimeout(handle: TimerHandle): void;
    /** Creates or updates objects */
    ensureObjects(definitions: ObjectDefinition[]): Promise<void>;
    /** Writes a state with ack=true */
    setState(id: string, value: ioBroker.StateValue): Promise<void>;
    /** Stored sessions of one slot, undefined = none */
    load(slot: number): Promise<string | undefined>;
    /** Stores the sessions of one slot */
    save(slot: number, text: string): Promise<void>;
}

interface Entry extends SessionCharger {
    store: SessionStore;
    lastSync: number | null;
}

type Task = { slot: number; kind: 'backfill' | 'recent' };

/**
 * Charging sessions of all selected chargers.
 */
export class EaseeSessions implements SessionControl {
    private entries: Entry[] = [];
    private queue: Task[] = [];
    private readonly timers = new Set<TimerHandle>();
    private runTimer: { handle: TimerHandle } | undefined;
    private running = false;
    private lastRequestAt = 0;
    private failureCount = 0;
    private stopped = false;

    /** Oldest time that is read and counted */
    private readonly limit: number;

    /**
     * @param pricePerKwh - Configured price, 0 = none
     * @param deps - Dependencies
     * @param since - Only sessions from this time on (epoch ms), null = all
     */
    public constructor(
        private readonly pricePerKwh: number,
        private readonly deps: SessionDeps,
        since: number | null = null,
    ) {
        this.limit = Math.max(BACKFILL_LIMIT, since ?? BACKFILL_LIMIT);
    }

    /** @inheritdoc */
    public async start(chargers: SessionCharger[]): Promise<void> {
        if (this.stopped) {
            return;
        }
        this.entries = [];
        for (const c of chargers) {
            const text = await this.deps.load(c.slot).catch(() => undefined);
            const store = SessionStore.parse(text);
            // start date moved further back: continue loading from where the last run stopped
            if (store.backfillDone && store.backfilledTo !== null && store.backfilledTo > this.limit) {
                store.backfillDone = false;
            }
            // start date moved forward: what is loaded already reaches back far enough
            if (!store.backfillDone && store.backfilledTo !== null && store.backfilledTo <= this.limit) {
                store.backfillDone = true;
            }
            this.entries.push({ ...c, store, lastSync: null });
        }
        const definitions = historyObjects(EASEE_ROOT, this.pricePerKwh > 0);
        for (const e of this.entries) {
            definitions.push(...historyObjects(chargerChannel(e.slot), this.pricePerKwh > 0));
        }
        await this.deps.ensureObjects(definitions);
        await this.writeStates();
        for (const e of this.entries) {
            this.enqueue({ slot: e.slot, kind: e.store.backfillDone ? 'recent' : 'backfill' });
        }
        this.scheduleRun(FIRST_REQUEST_MS);
        this.scheduleRefresh();
    }

    /** @inheritdoc */
    public carUnplugged(slot: number): void {
        if (this.stopped || !this.entries.some(e => e.slot === slot)) {
            return;
        }
        this.schedule(() => {
            this.enqueue({ slot, kind: 'recent' });
            this.scheduleRun(0);
        }, AFTER_UNPLUG_MS);
    }

    /** @inheritdoc */
    public stop(): void {
        this.stopped = true;
        for (const handle of this.timers) {
            this.deps.clearTimeout(handle);
        }
        this.timers.clear();
        this.runTimer = undefined;
    }

    /** Pending tasks (tests) */
    public pending(): Task[] {
        return [...this.queue];
    }

    /** Works on the first task; schedules itself for the rest */
    public async run(): Promise<void> {
        if (this.stopped || this.running) {
            return;
        }
        const task = this.queue[0];
        if (!task) {
            return;
        }
        const wait = this.lastRequestAt + REQUEST_GAP_MS - this.deps.now();
        if (this.lastRequestAt > 0 && wait > 0) {
            this.scheduleRun(wait);
            return;
        }
        const entry = this.entries.find(e => e.slot === task.slot);
        if (!entry) {
            this.queue.shift();
            this.scheduleRun(0);
            return;
        }
        this.running = true;
        let nextDelay: number | undefined = 0;
        try {
            await this.work(entry, task);
            this.failureCount = 0;
            this.queue.shift();
            // a finished backfill step may need the next one
            if (task.kind === 'backfill' && !entry.store.backfillDone) {
                this.enqueue({ slot: entry.slot, kind: 'backfill' });
            }
        } catch (error) {
            nextDelay = this.failed(error);
        } finally {
            this.running = false;
        }
        if (nextDelay !== undefined && this.queue.length > 0) {
            this.scheduleRun(nextDelay);
        }
    }

    /**
     * One request and its results.
     *
     * @param entry - Charger
     * @param task - Task
     */
    private async work(entry: Entry, task: Task): Promise<void> {
        const now = this.deps.now();
        const { store } = entry;
        let from: number;
        let to: number;
        if (task.kind === 'backfill') {
            to = store.backfilledTo ?? now;
            from = Math.max(to - BACKFILL_WINDOW_MS, this.limit);
            if (from >= to) {
                // already loaded back to the start date: never send an empty or reversed window
                store.backfillDone = true;
                return;
            }
        } else {
            to = now;
            from = Math.min(Math.max(now - RECENT_WINDOW_MS, this.limit), now - 3_600_000);
        }
        this.lastRequestAt = now;
        const sessions = await this.deps.getSessions(entry.serial, from, to);
        const changed = store.add(sessions);
        if (task.kind === 'backfill') {
            store.backfilledTo = from;
            if (sessions.length === 0 || from <= this.limit) {
                store.backfillDone = true;
                const used = store.list().filter(s => s.start >= this.limit);
                const oldest = used[0];
                this.deps.log.info(
                    `Easee: ${entry.name}: ${used.length} charging session(s) loaded${
                        oldest ? ` (since ${new Date(oldest.start).toISOString().slice(0, 10)})` : ''
                    }`,
                );
            } else {
                this.deps.log.debug(`Easee: ${entry.name}: ${sessions.length} older session(s) loaded`);
            }
        } else if (changed > 0) {
            this.deps.log.debug(`Easee: ${entry.name}: ${changed} new/changed session(s)`);
        }
        entry.lastSync = now;
        if (changed > 0 || task.kind === 'backfill') {
            await this.deps
                .save(entry.slot, store.serialize())
                .catch(error => this.deps.log.warn(`Easee: saving the sessions failed: ${describeError(error)}`));
        }
        await this.writeStates();
    }

    /**
     * @param error - Thrown error
     * @returns Delay before the next try, undefined = stop
     */
    private failed(error: unknown): number | undefined {
        if (error instanceof EaseeAbortedError || this.stopped) {
            return undefined;
        }
        if (error instanceof EaseeAuthError) {
            // the charger part logs the login problem and stops itself
            this.stop();
            return undefined;
        }
        this.failureCount++;
        let delay = Math.min(REQUEST_GAP_MS * 2 ** (this.failureCount - 1), MAX_BACKOFF_MS);
        if (error instanceof EaseeRateLimitedError) {
            delay = Math.max(delay, error.waitMs);
        }
        const level = this.failureCount >= 3 ? 'warn' : 'debug';
        this.deps.log[level](
            `Easee: reading charging sessions failed: ${describeError(error)}; next try in ${Math.round(delay / 60_000)} min`,
        );
        return delay;
    }

    /** Writes the states of all chargers and the sums */
    private async writeStates(): Promise<void> {
        const now = this.deps.now();
        const all: ChargeSession[] = [];
        for (const e of this.entries) {
            const list = e.store.list().filter(s => s.start >= this.limit);
            all.push(...list);
            await this.writeReport(chargerChannel(e.slot), new SessionReport(list, this.pricePerKwh), now);
            await this.deps.setState(`${chargerChannel(e.slot)}.history.sessionCount`, list.length);
            if (e.lastSync !== null) {
                await this.deps.setState(`${chargerChannel(e.slot)}.history.lastSync`, e.lastSync);
            }
        }
        await this.writeReport(EASEE_ROOT, new SessionReport(all, this.pricePerKwh), now);
        await this.deps.setState(`${EASEE_ROOT}.history.sessionCount`, all.length);
    }

    /**
     * @param prefix - easee or easee.chargerN
     * @param report - Evaluation
     * @param now - Current time
     */
    private async writeReport(prefix: string, report: SessionReport, now: number): Promise<void> {
        const p = `${prefix}.history`;
        const months = report.months(now, MONTHS);
        const month = months[months.length - 1];
        const year = report.year(new Date(now).getFullYear());
        await this.deps.setState(`${p}.days`, JSON.stringify(report.days(now, DAYS)));
        await this.deps.setState(`${p}.weeks`, JSON.stringify(report.weeks(now, WEEKS)));
        await this.deps.setState(`${p}.months`, JSON.stringify(months));
        await this.deps.setState(`${p}.monthEnergy`, month.kwh);
        await this.deps.setState(`${p}.yearEnergy`, year.kwh);
        if (this.pricePerKwh > 0) {
            await this.deps.setState(`${p}.monthCost`, month.cost);
            await this.deps.setState(`${p}.yearCost`, year.cost);
        }
        const last = report.last();
        await this.deps.setState(`${p}.lastSession`, last ? JSON.stringify(last) : null);
        await this.deps.setState(`${p}.oldestSession`, report.oldest());
    }

    /**
     * @param task - Task (not added twice)
     */
    private enqueue(task: Task): void {
        if (!this.queue.some(t => t.slot === task.slot && t.kind === task.kind)) {
            this.queue.push(task);
        }
    }

    /** Regular update of all chargers */
    private scheduleRefresh(): void {
        this.schedule(() => {
            for (const e of this.entries) {
                // charger whose backfill is still going: the backfill task covers it
                if (e.store.backfillDone) {
                    this.enqueue({ slot: e.slot, kind: 'recent' });
                }
            }
            this.scheduleRun(0);
            this.scheduleRefresh();
        }, REFRESH_MS);
    }

    /**
     * @param ms - Delay (earlier pending run wins only if it is not replaced)
     */
    private scheduleRun(ms: number): void {
        if (this.runTimer) {
            this.deps.clearTimeout(this.runTimer.handle);
            this.timers.delete(this.runTimer.handle);
        }
        const handle = this.schedule(() => {
            this.runTimer = undefined;
            void this.run();
        }, ms);
        this.runTimer = { handle };
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
