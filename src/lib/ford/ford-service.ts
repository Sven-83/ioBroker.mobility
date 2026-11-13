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
 * garage (model) once per login and day. Errors: backoff up to 60 min, 429 waits Retry-After.
 * A rejected refresh token -> new login needed (status + log), polling of that vehicle pauses.
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
import { FordAbortedError, FordClientRejectedError, FordLoginRequiredError, FordRateLimitedError } from './errors';
import { rootObjects, vehicleChannel, vehicleObjects } from './objects';
import { battery12vLow, isBev, parseTelemetry, sanitize } from './telemetry';

export const MAX_BACKOFF_MS = 60 * 60_000;
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
}

interface Vehicle {
    config: FordVehicleConfig;
    client: FordApi;
    loginState: string | undefined;
    loggedIn: boolean;
    /** Last garage read (epoch ms), null = not read yet */
    garageAt: number | null;
    failures: number;
    failureLog: FailureLog;
    /** Pending poll timer (wrapped: TimerHandle is unknown) */
    timer: { handle: TimerHandle } | undefined;
    expiryWarned: boolean;
    /** Last 12 V verdict (for logging changes only), undefined = not known yet */
    weak12v: boolean | undefined;
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
            failureLog: new FailureLog(),
            timer: undefined,
            expiryWarned: false,
            weak12v: undefined,
        }));
    }

    /** Creates objects and starts polling or asks for the login */
    public async start(): Promise<void> {
        const definitions = rootObjects();
        for (const v of this.vehicles) {
            definitions.push(...vehicleObjects(v.config.slot, v.config.name));
        }
        await this.deps.ensureObjects(definitions);
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
            await this.apply(v, body);
            v.failures = 0;
            const outage = v.failureLog.recovered(this.deps.now());
            if (outage !== undefined) {
                log.info(`Ford ${v.config.name}: reachable again (outage ${formatDuration(outage)})`);
            }
            this.updateConnection();
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
                this.updateConnection();
                return;
            }
            v.failures++;
            nextDelay = Math.min(intervalMs * 2 ** (v.failures - 1), Math.max(MAX_BACKOFF_MS, intervalMs));
            if (error instanceof FordRateLimitedError) {
                nextDelay = Math.max(nextDelay, error.waitMs);
            }
            const level = v.failureLog.failed(this.deps.now());
            log[level](`Ford ${v.config.name}: ${describeError(error)}; next try in ${formatDuration(nextDelay)}`);
            this.deps.onConnection(false);
        }
        this.schedulePoll(v, nextDelay + Math.floor(this.deps.random() * 30_000));
    }

    /**
     * Writes the states of one vehicle.
     *
     * @param v - Vehicle
     * @param body - Telemetry answer
     */
    private async apply(v: Vehicle, body: Record<string, unknown>): Promise<void> {
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
        await set('metricKeys', JSON.stringify(st.metricKeys));
        await set('raw', JSON.stringify(sanitize(body)));
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
        this.updateConnection();
    }

    /** info.connection of the Ford part: all vehicles logged in and without failure */
    private updateConnection(): void {
        this.deps.onConnection(this.vehicles.every(v => v.loggedIn && v.failures === 0));
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
 * Extra hint for the login error that was reported with a second FordPass account that only has shared access.
 *
 * @param code - Azure AD B2C error code or null
 */
export function sharedAccessHint(code: string | null): string {
    return code === B2C_SHARED_ACCESS_ERROR
        ? ' - this error was reported for FordPass accounts with shared vehicle access; try the login with the main FordPass account (owner) of this vehicle'
        : '';
}
