/*
 * Ford part of the adapter: one browser login per vehicle, then careful polling of /telemetry.
 *
 * Login flow (no public redirect needed):
 *  1. The adapter writes ford.vehicleN.login.url (random state, at most 16 characters).
 *  2. The user opens it, logs in with the separate FordPass account and picks the vehicle.
 *  3. Ford redirects to the redirect URI (default http://localhost/fordconnect) - the browser shows
 *     an error page, which is fine. The user copies its address into ford.vehicleN.login.response.
 *  4. The adapter exchanges the code, empties login.response at once (the code must not stay
 *     visible) and starts polling.
 *
 * Polling: every 5-60 min (default 10) plus a random 0-30 s, vehicles one after another;
 * garage (model) once per login and day. A vehicle whose data time does not change (parked,
 * no reception) is read less often: interval x2, x4, at most IDLE_MAX_MS; back to normal as soon
 * as new data arrive. Errors: backoff up to 60 min; 429 starts at twice the interval and doubles
 * up to RATE_LIMIT_MAX_MS (at least Retry-After).
 * A rejected refresh token -> new login needed (status + log), polling of that vehicle pauses.
 *
 * Status per vehicle (ford.vehicleN.reachable/problem/problemSince): a vehicle counts as not
 * reachable at once when a login is needed, otherwise when its reads fail for PROBLEM_AFTER_MS.
 * The Ford part (info.connection) stays connected while at least one vehicle is reachable;
 * single vehicles are reported through onIssues (info.issues) instead.
 */

import { describeError } from '../fuel/errors';
import type { Logger, TimerHandle } from '../fuel/fuel-service';
import type { ObjectDefinition } from '../fuel/objects';
import { FailureLog, formatDuration } from '../util/failure-log';
import type { FordConfig, FordVehicleConfig } from './config';
import {
    B2C_SHARED_ACCESS_ERROR,
    LOGIN_LIFETIME_MS,
    b2cErrorCode,
    buildAuthorizeUrl,
    parseRedirect,
    type GarageInfo,
} from './ford-client';
import {
    FordAbortedError,
    FordClientRejectedError,
    FordLoginRequiredError,
    FordNetworkError,
    FordRateLimitedError,
} from './errors';
import { rootObjects, vehicleChannel, vehicleObjects } from './objects';
import { battery12vLow, isBev, parseTelemetry, sanitize } from './telemetry';
import { computeWarnings, worstLevel } from './warnings';
import { VehicleHistory } from './history';

export const MAX_BACKOFF_MS = 60 * 60_000;
/** Longest pause for a vehicle that sends nothing new */
export const IDLE_MAX_MS = 2 * 3_600_000;
/** Longest pause after repeated 429 answers */
export const RATE_LIMIT_MAX_MS = 3 * 3_600_000;
/** Failing reads this long -> vehicle counts as not reachable */
export const PROBLEM_AFTER_MS = 60 * 60_000;
/** Warn this long before the browser login expires */
export const EXPIRY_WARNING_MS = 7 * 24 * 3_600_000;
/** Garage info is read again after this time */
export const GARAGE_MAX_AGE_MS = 24 * 3_600_000;

/** The part of the Ford client the service needs */
export interface FordApi {
    /** A login is stored */
    hasLogin(): Promise<boolean>;
    /** Exchanges the code */
    login(code: string): Promise<void>;
    /** Forgets the login */
    forgetLogin(): Promise<void>;
    /** Time of the browser login */
    authTime(): number | null;
    /** Vehicle info */
    getGarage(): Promise<GarageInfo>;
    /** Telemetry */
    getTelemetry(): Promise<Record<string, unknown>>;
    /** Cancels requests */
    abort(): void;
}

/** Everything the service needs from the outside */
export interface FordDeps {
    /** Client per vehicle slot */
    createClient(slot: number): FordApi;
    /** Adapter log */
    log: Logger;
    /** Current time */
    now(): number;
    /** 0 <= value < 1 */
    random(): number;
    /** Random state for the login (hex) */
    randomState(): string;
    /** adapter.setTimeout */
    setTimeout(callback: () => void, ms: number): TimerHandle;
    /** adapter.clearTimeout */
    clearTimeout(handle: TimerHandle): void;
    /** Creates or updates objects */
    ensureObjects(definitions: ObjectDefinition[]): Promise<void>;
    /** Writes a state with ack=true */
    setState(id: string, value: ioBroker.StateValue): Promise<void>;
    /** Connection status of the Ford part */
    onConnection(connected: boolean): void;
    /** Vehicles that are not reachable (empty list = all fine) */
    onIssues?(issues: FordIssue[]): void;
    /** Reads the stored history of one vehicle (undefined = none yet) */
    loadHistory(slot: number): Promise<string | undefined>;
    /** Stores the history of one vehicle */
    saveHistory(slot: number, text: string): Promise<void>;
}

/** Why a vehicle delivers no data */
export type FordProblem = 'login' | 'rateLimited' | 'noAnswer' | 'error';

/** One vehicle that is not reachable */
export interface FordIssue {
    /** Vehicle slot */
    slot: number;
    /** Display name */
    name: string;
    /** Why */
    problem: FordProblem;
    /** Since when (epoch ms) */
    since: number;
    /** Time of the last vehicle data (epoch ms), null if unknown */
    lastData: number | null;
}

interface Vehicle {
    config: FordVehicleConfig;
    client: FordApi;
    loginState: string | undefined;
    loggedIn: boolean;
    /** Last garage read (epoch ms), null = not read yet */
    garageAt: number | null;
    failures: number;
    /** 429 answers in a row */
    rateHits: number;
    failureLog: FailureLog;
    /** Current problem (also before it counts as not reachable), null = fine */
    problem: { kind: FordProblem; since: number; atOnce: boolean } | null;
    /** Last value written to reachable (written only on change) */
    reachableWritten: boolean | undefined;
    /** Data time of the last read (epoch ms), null = unknown */
    lastData: number | null;
    /** Reads in a row without new data */
    idle: number;
    /** Pending poll timer (wrapped: TimerHandle is unknown) */
    timer: { handle: TimerHandle } | undefined;
    expiryWarned: boolean;
    /** Last 12 V verdict (for logging changes only), undefined = not known yet */
    weak12v: boolean | undefined;
    /** Since when the vehicle is unlocked (epoch ms), null if locked or unknown */
    unlockedSince: number | null;
    /** Trips, consumption, tyre trend */
    history: VehicleHistory;
}

/**
 * Ford service for one validated config.
 */
export class FordService {
    private readonly vehicles: Vehicle[];
    private readonly timers = new Set<TimerHandle>();
    private stopped = false;

    /**
     * @param config - Validated Ford config (enabled)
     * @param deps - Dependencies
     */
    public constructor(
        private readonly config: FordConfig,
        private readonly deps: FordDeps,
    ) {
        this.vehicles = config.vehicles.map(v => ({
            config: v,
            client: deps.createClient(v.slot),
            loginState: undefined,
            loggedIn: false,
            garageAt: null,
            failures: 0,
            rateHits: 0,
            failureLog: new FailureLog(),
            problem: null,
            reachableWritten: undefined,
            lastData: null,
            idle: 0,
            timer: undefined,
            expiryWarned: false,
            weak12v: undefined,
            unlockedSince: null,
            history: new VehicleHistory(),
        }));
    }

    /** Creates objects and starts polling or asks for the login */
    public async start(): Promise<void> {
        const definitions = rootObjects();
        for (const v of this.vehicles) {
            definitions.push(...vehicleObjects(v.config.slot, v.config.name));
        }
        await this.deps.ensureObjects(definitions);
        for (const v of this.vehicles) {
            const loaded = VehicleHistory.parse(await this.deps.loadHistory(v.config.slot).catch(() => undefined));
            if (!loaded.ok) {
                this.deps.log.warn(`Ford ${v.config.name}: stored history could not be read, starting a new one`);
            }
            v.history = loaded.history;
        }
        for (const [index, v] of this.vehicles.entries()) {
            const ch = vehicleChannel(v.config.slot);
            await this.deps.setState(`${ch}.name`, v.config.name);
            if (await v.client.hasLogin()) {
                v.loggedIn = true;
                await this.deps.setState(`${ch}.login.status`, 'OK');
                await this.deps.setState(`${ch}.login.url`, '');
                // stagger the vehicles, random first delay
                this.schedulePoll(v, 5_000 + index * 20_000 + Math.floor(this.deps.random() * 30_000));
            } else {
                await this.requireLogin(v, 'no login yet');
            }
        }
        this.deps.log.info(
            `Ford: ${this.vehicles.map(v => v.config.name).join(', ')}, every ${this.config.intervalMin} min`,
        );
    }

    /** Stops timers and requests */
    public stop(): void {
        this.stopped = true;
        for (const handle of this.timers) {
            this.deps.clearTimeout(handle);
        }
        this.timers.clear();
        for (const v of this.vehicles) {
            v.client.abort();
        }
    }

    /**
     * The user pasted the address after the login.
     *
     * @param slot - Vehicle slot
     * @param text - Pasted address or code
     */
    public async handleLoginResponse(slot: number, text: string): Promise<void> {
        const v = this.vehicles.find(x => x.config.slot === slot);
        if (!v || this.stopped) {
            return;
        }
        const ch = vehicleChannel(slot);
        // the code must not stay visible in the object tree
        await this.deps.setState(`${ch}.login.response`, '');
        if (!text.trim()) {
            return;
        }
        const { log } = this.deps;
        const parsed = parseRedirect(text);
        if (parsed.error) {
            const code = b2cErrorCode(parsed.error);
            log.warn(
                `Ford ${v.config.name}: the login page reported an error${code ? ` (${code})` : ''} - please try again${sharedAccessHint(code)}`,
            );
            await this.deps.setState(`${ch}.login.status`, 'Login failed on the Ford page - try again');
            return;
        }
        if (!parsed.code) {
            log.warn(`Ford ${v.config.name}: no code found in the pasted text`);
            return;
        }
        if (parsed.state !== null && parsed.state !== v.loginState) {
            log.warn(`Ford ${v.config.name}: this address belongs to an older login link - please use the current one`);
            await this.deps.setState(`${ch}.login.status`, 'Old login link used - open login.url again');
            return;
        }
        try {
            await v.client.login(parsed.code);
        } catch (error) {
            if (error instanceof FordClientRejectedError) {
                log.error(`Ford: ${describeError(error)} - check client ID/secret in the instance settings`);
            } else {
                const message = describeError(error);
                log.warn(`Ford ${v.config.name}: login failed: ${message}${sharedAccessHint(b2cErrorCode(message))}`);
            }
            await this.deps.setState(`${ch}.login.status`, 'Login failed - see log, open login.url again');
            await this.requireLogin(v, 'login failed');
            return;
        }
        v.loggedIn = true;
        v.loginState = undefined;
        v.failures = 0;
        v.rateHits = 0;
        v.idle = 0;
        v.garageAt = null;
        log.info(`Ford ${v.config.name}: login OK`);
        await this.deps.setState(`${ch}.login.status`, 'OK');
        await this.deps.setState(`${ch}.login.url`, '');
        this.schedulePoll(v, 2_000);
    }

    /**
     * Reads one vehicle now (refresh button).
     *
     * @param slot - Vehicle slot
     */
    public requestPoll(slot: number): void {
        const v = this.vehicles.find(x => x.config.slot === slot);
        if (v?.loggedIn && !this.stopped) {
            this.schedulePoll(v, 0);
        }
    }

    /**
     * One poll of one vehicle; schedules the next itself.
     *
     * @param v - Vehicle
     */
    private async poll(v: Vehicle): Promise<void> {
        if (this.stopped || !v.loggedIn) {
            return;
        }
        const { log } = this.deps;
        const ch = vehicleChannel(v.config.slot);
        const intervalMs = this.config.intervalMin * 60_000;
        let nextDelay = intervalMs;
        try {
            if (v.garageAt === null || this.deps.now() - v.garageAt >= GARAGE_MAX_AGE_MS) {
                const garage = await v.client.getGarage();
                v.garageAt = this.deps.now();
                if (garage.vehicleType) {
                    await this.deps.setState(`${ch}.model`, garage.vehicleType);
                }
                if (garage.engineType) {
                    await this.deps.setState(`${ch}.engineType`, garage.engineType);
                }
            }
            const body = await v.client.getTelemetry();
            const dataTime = await this.apply(v, body);
            v.failures = 0;
            v.rateHits = 0;
            // parked or no reception: the vehicle sends nothing new -> read it less often
            if (dataTime !== null && dataTime === v.lastData) {
                v.idle++;
            } else {
                v.idle = 0;
            }
            if (dataTime !== null) {
                v.lastData = dataTime;
            }
            nextDelay = Math.min(intervalMs * 2 ** Math.min(v.idle, 2), Math.max(IDLE_MAX_MS, intervalMs));
            const outage = v.failureLog.recovered(this.deps.now());
            if (outage !== undefined) {
                log.info(`Ford ${v.config.name}: reachable again (outage ${formatDuration(outage)})`);
            }
            await this.setProblem(v, null);
            await this.checkExpiry(v);
        } catch (error) {
            if (error instanceof FordAbortedError || this.stopped) {
                return;
            }
            if (error instanceof FordLoginRequiredError) {
                await v.client.forgetLogin().catch(() => undefined);
                await this.requireLogin(v, describeError(error));
                return;
            }
            if (error instanceof FordClientRejectedError) {
                log.error(`Ford: ${describeError(error)} - check client ID/secret in the instance settings`);
                v.loggedIn = false;
                await this.setProblem(v, 'error', true);
                return;
            }
            v.failures++;
            if (error instanceof FordRateLimitedError) {
                // Ford counts every call: wait longer each time instead of asking again soon
                v.rateHits++;
                nextDelay = Math.max(
                    Math.min(2 * intervalMs * 2 ** (v.rateHits - 1), Math.max(RATE_LIMIT_MAX_MS, intervalMs)),
                    error.waitMs,
                );
            } else {
                nextDelay = Math.min(intervalMs * 2 ** (v.failures - 1), Math.max(MAX_BACKOFF_MS, intervalMs));
            }
            const level = v.failureLog.failed(this.deps.now());
            log[level](`Ford ${v.config.name}: ${describeError(error)}; next try in ${formatDuration(nextDelay)}`);
            await this.setProblem(v, problemOf(error));
        }
        this.schedulePoll(v, nextDelay + Math.floor(this.deps.random() * 30_000));
    }

    /**
     * Writes the states of one vehicle.
     *
     * @param v - Vehicle
     * @param body - Telemetry answer
     * @returns Time of the vehicle data (epoch ms), null if the answer has none
     */
    private async apply(v: Vehicle, body: Record<string, unknown>): Promise<number | null> {
        const ch = vehicleChannel(v.config.slot);
        const st = parseTelemetry(body);
        const set = async (key: string, value: ioBroker.StateValue | null): Promise<void> => {
            if (value !== null) {
                await this.deps.setState(`${ch}.${key}`, value);
            }
        };
        // not meaningful in this situation: write null so no stale value stays visible
        const clear = (key: string): Promise<void> => this.deps.setState(`${ch}.${key}`, null);
        await set('lastUpdate', st.updateTime);
        await set('fuelLevel', st.fuelLevel);
        // a BEV reports fuelRange 0 - not meaningful
        await (isBev(st) ? clear('fuelRange') : set('fuelRange', st.fuelRange));
        await set('soc', st.soc);
        await set('evRange', st.evRange);
        await set('plugStatus', st.plugStatus);
        await set('chargeStatus', st.chargeStatus);
        // Ford keeps the last estimate after unplugging - only show it while plugged in
        const unplugged = st.plugStatus?.toUpperCase() === 'DISCONNECTED';
        await (unplugged ? clear('timeToFull') : set('timeToFull', st.timeToFull));
        await set('energyRemaining', st.energyRemaining);
        await set('batteryCapacity', st.batteryCapacity);
        await set('evMaxRange', st.evMaxRange);
        await set('batteryTemp', st.batteryTemp);
        await set('chargePower', unplugged ? 0 : st.chargePower);
        await set('odometer', st.odometer);
        await set('battery12v', st.battery12v);
        await set('battery12vVoltage', st.battery12vVoltage);
        const weak = battery12vLow(st);
        await set('battery12vLow', weak);
        if (weak !== null && weak !== v.weak12v) {
            if (weak) {
                this.deps.log.warn(
                    `Ford ${v.config.name}: 12 V battery weak (${st.battery12v ?? '?'} %, ${st.battery12vVoltage ?? '?'} V)`,
                );
            } else if (v.weak12v) {
                this.deps.log.info(`Ford ${v.config.name}: 12 V battery OK again`);
            }
            v.weak12v = weak;
        }
        await set('oilLife', st.oilLife);
        await set('outsideTemp', st.outsideTemp);
        await set('coolantTemp', st.coolantTemp);
        await set('ignition', st.ignition);
        await set('alarm', st.alarm);
        await set('doorsClosed', st.doorsClosed);
        await set('locked', st.locked);
        await set('windowsClosed', st.windowsClosed);
        for (const [wheel, pressure] of Object.entries(st.tires)) {
            await set(`tires.${wheel}`, pressure);
        }
        // history (trips, consumption, tyre trend)
        const now = this.deps.now();
        v.history.add({
            t: st.updateTime ?? now,
            odo: st.odometer,
            temp: st.outsideTemp,
            fuel: isBev(st) ? null : st.fuelLevel,
            energy: st.energyRemaining,
            tyres: st.tires,
        });
        await this.writeHistory(v, now);

        // warnings for the dashboard
        if (st.locked === false) {
            v.unlockedSince ??= st.lockTime ?? this.deps.now();
        } else if (st.locked === true) {
            v.unlockedSince = null;
        }
        const authTime = v.client.authTime();
        const warnings = computeWarnings(st, {
            now,
            tyreLoss: v.history.tyreLoss(now),
            unlockedSince: v.unlockedSince,
            loginExpires: authTime === null ? null : authTime + LOGIN_LIFETIME_MS,
            hour: new Date(now).getHours(),
        });
        await set('warnings', JSON.stringify(warnings));
        await set('warningLevel', worstLevel(warnings));
        await set('warningCount', warnings.length);
        await set('metricKeys', JSON.stringify(st.metricKeys));
        await set('raw', JSON.stringify(sanitize(body)));
        return st.updateTime;
    }

    /**
     * Writes the history states and stores the history file.
     *
     * @param v - Vehicle
     * @param now - Current time
     */
    private async writeHistory(v: Vehicle, now: number): Promise<void> {
        const ch = vehicleChannel(v.config.slot);
        const tank = v.config.tankLitres;
        const weeks = v.history.weeks(now, 8, tank);
        const recent = weeks.slice(-4);
        const kwh = recent.reduce((a, w) => a + w.kwhUsed, 0);
        const km = recent.reduce((a, w) => a + w.kmEv, 0);
        await this.deps.setState(`${ch}.tankCapacity`, tank > 0 ? tank : null);
        await this.deps.setState(`${ch}.history.days`, JSON.stringify(v.history.dailies(now, 14, tank)));
        await this.deps.setState(`${ch}.history.weeks`, JSON.stringify(weeks));
        await this.deps.setState(`${ch}.history.months`, JSON.stringify(v.history.months(now, 12, tank)));
        await this.deps.setState(`${ch}.history.tyreLoss`, JSON.stringify(v.history.tyreLoss(now)));
        await this.deps.setState(
            `${ch}.history.energyConsumption`,
            km >= 20 ? Math.round((kwh / km) * 1000) / 10 : null,
        );
        await this.deps.setState(`${ch}.history.fuelConsumption`, v.history.fuelConsumption(tank));
        const refuel = v.history.lastRefuel();
        await this.deps.setState(`${ch}.history.lastRefuel`, refuel ? JSON.stringify(refuel) : null);
        await this.deps.saveHistory(v.config.slot, v.history.serialize()).catch(error => {
            this.deps.log.warn(`Ford ${v.config.name}: history could not be stored: ${describeError(error)}`);
        });
    }

    /**
     * Shows the expiry of the browser login and warns a week before.
     *
     * @param v - Vehicle
     */
    private async checkExpiry(v: Vehicle): Promise<void> {
        const authTime = v.client.authTime();
        if (authTime === null) {
            return;
        }
        const expires = authTime + LOGIN_LIFETIME_MS;
        await this.deps.setState(`${vehicleChannel(v.config.slot)}.login.expires`, expires);
        if (!v.expiryWarned && expires - this.deps.now() < EXPIRY_WARNING_MS) {
            v.expiryWarned = true;
            this.deps.log.warn(
                `Ford ${v.config.name}: the Ford login expires on ${new Date(expires).toISOString().slice(0, 10)} - ` +
                    'please log in again soon (login.url appears when it has expired)',
            );
        }
    }

    /**
     * Publishes a new login link and pauses polling of the vehicle.
     *
     * @param v - Vehicle
     * @param reason - Why (for the log)
     */
    private async requireLogin(v: Vehicle, reason: string): Promise<void> {
        v.loggedIn = false;
        if (v.timer !== undefined) {
            this.deps.clearTimeout(v.timer.handle);
            this.timers.delete(v.timer.handle);
            v.timer = undefined;
        }
        v.loginState = this.deps.randomState().slice(0, 16);
        const ch = vehicleChannel(v.config.slot);
        await this.deps.setState(
            `${ch}.login.url`,
            buildAuthorizeUrl(this.config.clientId, this.config.redirectUri, v.loginState),
        );
        await this.deps.setState(`${ch}.login.status`, 'Login needed: open login.url, then paste the address');
        this.deps.log.warn(
            `Ford ${v.config.name}: login needed (${reason}). Open ${ch}.login.url in the browser, log in with ` +
                `the FordPass account, pick "${v.config.name}" and paste the address of the page shown afterwards ` +
                `into ${ch}.login.response`,
        );
        await this.setProblem(v, 'login', true);
    }

    /**
     * Notes the problem of one vehicle (null = fine) and updates its status states.
     *
     * @param v - Vehicle
     * @param kind - Problem, null when the read worked
     * @param atOnce - Counts as not reachable immediately (login needed, client rejected)
     */
    private async setProblem(v: Vehicle, kind: FordProblem | null, atOnce = false): Promise<void> {
        const now = this.deps.now();
        if (kind === null) {
            v.problem = null;
        } else if (v.problem === null) {
            v.problem = { kind, since: now, atOnce };
        } else {
            // keep the start of an ongoing outage, only the kind changes
            v.problem.kind = kind;
            v.problem.atOnce = v.problem.atOnce || atOnce;
        }
        const reachable = this.isReachable(v, now);
        const ch = vehicleChannel(v.config.slot);
        if (reachable !== v.reachableWritten) {
            v.reachableWritten = reachable;
            await this.deps.setState(`${ch}.reachable`, reachable);
            await this.deps.setState(`${ch}.problemSince`, reachable ? null : (v.problem?.since ?? now));
        }
        await this.deps.setState(`${ch}.problem`, reachable ? '' : (v.problem?.kind ?? 'login'));
        this.updateConnection();
    }

    /**
     * @param v - Vehicle
     * @param now - Current time
     */
    private isReachable(v: Vehicle, now: number): boolean {
        if (v.problem === null) {
            return v.loggedIn;
        }
        return !(v.problem.atOnce || v.problem.kind === 'login' || now - v.problem.since >= PROBLEM_AFTER_MS);
    }

    /** info.connection of the Ford part: at least one vehicle reachable; the others go to onIssues */
    private updateConnection(): void {
        const now = this.deps.now();
        const down = this.vehicles.filter(v => !this.isReachable(v, now));
        this.deps.onConnection(down.length < this.vehicles.length);
        this.deps.onIssues?.(
            down.map(v => ({
                slot: v.config.slot,
                name: v.config.name,
                problem: v.problem?.kind ?? 'login',
                since: v.problem?.since ?? now,
                lastData: v.lastData,
            })),
        );
    }

    /**
     * @param v - Vehicle
     * @param ms - Delay
     */
    private schedulePoll(v: Vehicle, ms: number): void {
        if (v.timer !== undefined) {
            this.deps.clearTimeout(v.timer.handle);
            this.timers.delete(v.timer.handle);
        }
        const handle = this.deps.setTimeout(() => {
            this.timers.delete(handle);
            v.timer = undefined;
            if (!this.stopped) {
                void this.poll(v);
            }
        }, ms);
        v.timer = { handle };
        this.timers.add(handle);
    }
}

/**
 * @param error - Error of a read
 */
function problemOf(error: unknown): FordProblem {
    if (error instanceof FordRateLimitedError) {
        return 'rateLimited';
    }
    if (error instanceof FordNetworkError) {
        return 'noAnswer';
    }
    return 'error';
}

/**
 * Extra hint for the login error that was reported with a second FordPass account that only has shared access.
 *
 * @param code - Azure AD B2C error code or null
 */
export function sharedAccessHint(code: string | null): string {
    return code === B2C_SHARED_ACCESS_ERROR
        ? ' - this error was reported for FordPass accounts with shared vehicle access; try the login with the main FordPass account (owner) of this vehicle'
        : '';
}
