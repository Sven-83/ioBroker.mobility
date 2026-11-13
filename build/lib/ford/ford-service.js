"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var ford_service_exports = {};
__export(ford_service_exports, {
  EXPIRY_WARNING_MS: () => EXPIRY_WARNING_MS,
  FordService: () => FordService,
  GARAGE_MAX_AGE_MS: () => GARAGE_MAX_AGE_MS,
  MAX_BACKOFF_MS: () => MAX_BACKOFF_MS,
  sharedAccessHint: () => sharedAccessHint
});
module.exports = __toCommonJS(ford_service_exports);
var import_errors = require("../fuel/errors");
var import_failure_log = require("../util/failure-log");
var import_ford_client = require("./ford-client");
var import_errors2 = require("./errors");
var import_objects = require("./objects");
var import_telemetry = require("./telemetry");
var import_warnings = require("./warnings");
const MAX_BACKOFF_MS = 60 * 6e4;
const EXPIRY_WARNING_MS = 7 * 24 * 36e5;
const GARAGE_MAX_AGE_MS = 24 * 36e5;
class FordService {
  /**
   * @param config - Validated Ford config (enabled)
   * @param deps - Dependencies
   */
  constructor(config, deps) {
    this.config = config;
    this.deps = deps;
    this.vehicles = config.vehicles.map((v) => ({
      config: v,
      client: deps.createClient(v.slot),
      loginState: void 0,
      loggedIn: false,
      garageAt: null,
      failures: 0,
      failureLog: new import_failure_log.FailureLog(),
      timer: void 0,
      expiryWarned: false,
      weak12v: void 0,
      unlockedSince: null
    }));
  }
  vehicles;
  timers = /* @__PURE__ */ new Set();
  stopped = false;
  /** Creates objects and starts polling or asks for the login */
  async start() {
    const definitions = (0, import_objects.rootObjects)();
    for (const v of this.vehicles) {
      definitions.push(...(0, import_objects.vehicleObjects)(v.config.slot, v.config.name));
    }
    await this.deps.ensureObjects(definitions);
    for (const [index, v] of this.vehicles.entries()) {
      const ch = (0, import_objects.vehicleChannel)(v.config.slot);
      await this.deps.setState(`${ch}.name`, v.config.name);
      if (await v.client.hasLogin()) {
        v.loggedIn = true;
        await this.deps.setState(`${ch}.login.status`, "OK");
        await this.deps.setState(`${ch}.login.url`, "");
        this.schedulePoll(v, 5e3 + index * 2e4 + Math.floor(this.deps.random() * 3e4));
      } else {
        await this.requireLogin(v, "no login yet");
      }
    }
    this.deps.log.info(
      `Ford: ${this.vehicles.map((v) => v.config.name).join(", ")}, every ${this.config.intervalMin} min`
    );
  }
  /** Stops timers and requests */
  stop() {
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
  async handleLoginResponse(slot, text) {
    const v = this.vehicles.find((x) => x.config.slot === slot);
    if (!v || this.stopped) {
      return;
    }
    const ch = (0, import_objects.vehicleChannel)(slot);
    await this.deps.setState(`${ch}.login.response`, "");
    if (!text.trim()) {
      return;
    }
    const { log } = this.deps;
    const parsed = (0, import_ford_client.parseRedirect)(text);
    if (parsed.error) {
      const code = (0, import_ford_client.b2cErrorCode)(parsed.error);
      log.warn(
        `Ford ${v.config.name}: the login page reported an error${code ? ` (${code})` : ""} - please try again${sharedAccessHint(code)}`
      );
      await this.deps.setState(`${ch}.login.status`, "Login failed on the Ford page - try again");
      return;
    }
    if (!parsed.code) {
      log.warn(`Ford ${v.config.name}: no code found in the pasted text`);
      return;
    }
    if (parsed.state !== null && parsed.state !== v.loginState) {
      log.warn(`Ford ${v.config.name}: this address belongs to an older login link - please use the current one`);
      await this.deps.setState(`${ch}.login.status`, "Old login link used - open login.url again");
      return;
    }
    try {
      await v.client.login(parsed.code);
    } catch (error) {
      if (error instanceof import_errors2.FordClientRejectedError) {
        log.error(`Ford: ${(0, import_errors.describeError)(error)} - check client ID/secret in the instance settings`);
      } else {
        const message = (0, import_errors.describeError)(error);
        log.warn(`Ford ${v.config.name}: login failed: ${message}${sharedAccessHint((0, import_ford_client.b2cErrorCode)(message))}`);
      }
      await this.deps.setState(`${ch}.login.status`, "Login failed - see log, open login.url again");
      await this.requireLogin(v, "login failed");
      return;
    }
    v.loggedIn = true;
    v.loginState = void 0;
    v.failures = 0;
    v.garageAt = null;
    log.info(`Ford ${v.config.name}: login OK`);
    await this.deps.setState(`${ch}.login.status`, "OK");
    await this.deps.setState(`${ch}.login.url`, "");
    this.schedulePoll(v, 2e3);
  }
  /**
   * Reads one vehicle now (refresh button).
   *
   * @param slot - Vehicle slot
   */
  requestPoll(slot) {
    const v = this.vehicles.find((x) => x.config.slot === slot);
    if ((v == null ? void 0 : v.loggedIn) && !this.stopped) {
      this.schedulePoll(v, 0);
    }
  }
  /**
   * One poll of one vehicle; schedules the next itself.
   *
   * @param v - Vehicle
   */
  async poll(v) {
    if (this.stopped || !v.loggedIn) {
      return;
    }
    const { log } = this.deps;
    const ch = (0, import_objects.vehicleChannel)(v.config.slot);
    const intervalMs = this.config.intervalMin * 6e4;
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
      if (outage !== void 0) {
        log.info(`Ford ${v.config.name}: reachable again (outage ${(0, import_failure_log.formatDuration)(outage)})`);
      }
      this.updateConnection();
      await this.checkExpiry(v);
    } catch (error) {
      if (error instanceof import_errors2.FordAbortedError || this.stopped) {
        return;
      }
      if (error instanceof import_errors2.FordLoginRequiredError) {
        await v.client.forgetLogin().catch(() => void 0);
        await this.requireLogin(v, (0, import_errors.describeError)(error));
        return;
      }
      if (error instanceof import_errors2.FordClientRejectedError) {
        log.error(`Ford: ${(0, import_errors.describeError)(error)} - check client ID/secret in the instance settings`);
        v.loggedIn = false;
        this.updateConnection();
        return;
      }
      v.failures++;
      nextDelay = Math.min(intervalMs * 2 ** (v.failures - 1), Math.max(MAX_BACKOFF_MS, intervalMs));
      if (error instanceof import_errors2.FordRateLimitedError) {
        nextDelay = Math.max(nextDelay, error.waitMs);
      }
      const level = v.failureLog.failed(this.deps.now());
      log[level](`Ford ${v.config.name}: ${(0, import_errors.describeError)(error)}; next try in ${(0, import_failure_log.formatDuration)(nextDelay)}`);
      this.deps.onConnection(false);
    }
    this.schedulePoll(v, nextDelay + Math.floor(this.deps.random() * 3e4));
  }
  /**
   * Writes the states of one vehicle.
   *
   * @param v - Vehicle
   * @param body - Telemetry answer
   */
  async apply(v, body) {
    var _a, _b, _c, _d, _e;
    const ch = (0, import_objects.vehicleChannel)(v.config.slot);
    const st = (0, import_telemetry.parseTelemetry)(body);
    const set = async (key, value) => {
      if (value !== null) {
        await this.deps.setState(`${ch}.${key}`, value);
      }
    };
    const clear = (key) => this.deps.setState(`${ch}.${key}`, null);
    await set("lastUpdate", st.updateTime);
    await set("fuelLevel", st.fuelLevel);
    await ((0, import_telemetry.isBev)(st) ? clear("fuelRange") : set("fuelRange", st.fuelRange));
    await set("soc", st.soc);
    await set("evRange", st.evRange);
    await set("plugStatus", st.plugStatus);
    await set("chargeStatus", st.chargeStatus);
    const unplugged = ((_a = st.plugStatus) == null ? void 0 : _a.toUpperCase()) === "DISCONNECTED";
    await (unplugged ? clear("timeToFull") : set("timeToFull", st.timeToFull));
    await set("energyRemaining", st.energyRemaining);
    await set("batteryCapacity", st.batteryCapacity);
    await set("evMaxRange", st.evMaxRange);
    await set("batteryTemp", st.batteryTemp);
    await set("chargePower", unplugged ? 0 : st.chargePower);
    await set("odometer", st.odometer);
    await set("battery12v", st.battery12v);
    await set("battery12vVoltage", st.battery12vVoltage);
    const weak = (0, import_telemetry.battery12vLow)(st);
    await set("battery12vLow", weak);
    if (weak !== null && weak !== v.weak12v) {
      if (weak) {
        this.deps.log.warn(
          `Ford ${v.config.name}: 12 V battery weak (${(_b = st.battery12v) != null ? _b : "?"} %, ${(_c = st.battery12vVoltage) != null ? _c : "?"} V)`
        );
      } else if (v.weak12v) {
        this.deps.log.info(`Ford ${v.config.name}: 12 V battery OK again`);
      }
      v.weak12v = weak;
    }
    await set("oilLife", st.oilLife);
    await set("outsideTemp", st.outsideTemp);
    await set("coolantTemp", st.coolantTemp);
    await set("ignition", st.ignition);
    await set("alarm", st.alarm);
    await set("doorsClosed", st.doorsClosed);
    await set("locked", st.locked);
    await set("windowsClosed", st.windowsClosed);
    for (const [wheel, pressure] of Object.entries(st.tires)) {
      await set(`tires.${wheel}`, pressure);
    }
    if (st.locked === false) {
      (_e = v.unlockedSince) != null ? _e : v.unlockedSince = (_d = st.lockTime) != null ? _d : this.deps.now();
    } else if (st.locked === true) {
      v.unlockedSince = null;
    }
    const authTime = v.client.authTime();
    const now = this.deps.now();
    const warnings = (0, import_warnings.computeWarnings)(st, {
      now,
      unlockedSince: v.unlockedSince,
      loginExpires: authTime === null ? null : authTime + import_ford_client.LOGIN_LIFETIME_MS,
      hour: new Date(now).getHours()
    });
    await set("warnings", JSON.stringify(warnings));
    await set("warningLevel", (0, import_warnings.worstLevel)(warnings));
    await set("warningCount", warnings.length);
    await set("metricKeys", JSON.stringify(st.metricKeys));
    await set("raw", JSON.stringify((0, import_telemetry.sanitize)(body)));
  }
  /**
   * Shows the expiry of the browser login and warns a week before.
   *
   * @param v - Vehicle
   */
  async checkExpiry(v) {
    const authTime = v.client.authTime();
    if (authTime === null) {
      return;
    }
    const expires = authTime + import_ford_client.LOGIN_LIFETIME_MS;
    await this.deps.setState(`${(0, import_objects.vehicleChannel)(v.config.slot)}.login.expires`, expires);
    if (!v.expiryWarned && expires - this.deps.now() < EXPIRY_WARNING_MS) {
      v.expiryWarned = true;
      this.deps.log.warn(
        `Ford ${v.config.name}: the Ford login expires on ${new Date(expires).toISOString().slice(0, 10)} - please log in again soon (login.url appears when it has expired)`
      );
    }
  }
  /**
   * Publishes a new login link and pauses polling of the vehicle.
   *
   * @param v - Vehicle
   * @param reason - Why (for the log)
   */
  async requireLogin(v, reason) {
    v.loggedIn = false;
    if (v.timer !== void 0) {
      this.deps.clearTimeout(v.timer.handle);
      this.timers.delete(v.timer.handle);
      v.timer = void 0;
    }
    v.loginState = this.deps.randomState().slice(0, 16);
    const ch = (0, import_objects.vehicleChannel)(v.config.slot);
    await this.deps.setState(
      `${ch}.login.url`,
      (0, import_ford_client.buildAuthorizeUrl)(this.config.clientId, this.config.redirectUri, v.loginState)
    );
    await this.deps.setState(`${ch}.login.status`, "Login needed: open login.url, then paste the address");
    this.deps.log.warn(
      `Ford ${v.config.name}: login needed (${reason}). Open ${ch}.login.url in the browser, log in with the FordPass account, pick "${v.config.name}" and paste the address of the page shown afterwards into ${ch}.login.response`
    );
    this.updateConnection();
  }
  /** info.connection of the Ford part: all vehicles logged in and without failure */
  updateConnection() {
    this.deps.onConnection(this.vehicles.every((v) => v.loggedIn && v.failures === 0));
  }
  /**
   * @param v - Vehicle
   * @param ms - Delay
   */
  schedulePoll(v, ms) {
    if (v.timer !== void 0) {
      this.deps.clearTimeout(v.timer.handle);
      this.timers.delete(v.timer.handle);
    }
    const handle = this.deps.setTimeout(() => {
      this.timers.delete(handle);
      v.timer = void 0;
      if (!this.stopped) {
        void this.poll(v);
      }
    }, ms);
    v.timer = { handle };
    this.timers.add(handle);
  }
}
function sharedAccessHint(code) {
  return code === import_ford_client.B2C_SHARED_ACCESS_ERROR ? " - this error was reported for FordPass accounts with shared vehicle access; try the login with the main FordPass account (owner) of this vehicle" : "";
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  EXPIRY_WARNING_MS,
  FordService,
  GARAGE_MAX_AGE_MS,
  MAX_BACKOFF_MS,
  sharedAccessHint
});
//# sourceMappingURL=ford-service.js.map
