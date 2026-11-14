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
var easee_service_exports = {};
__export(easee_service_exports, {
  AFTER_COMMAND_POLLS_MS: () => AFTER_COMMAND_POLLS_MS,
  AUTO_SELECT_MAX: () => AUTO_SELECT_MAX,
  COMMAND_GAP_MS: () => COMMAND_GAP_MS,
  COMMAND_SETTLE_MS: () => COMMAND_SETTLE_MS,
  DISCOVERY_RETRY_MS: () => DISCOVERY_RETRY_MS,
  EaseeService: () => EaseeService,
  MAX_BACKOFF_MS: () => MAX_BACKOFF_MS,
  NO_CHARGER_RETRY_MS: () => NO_CHARGER_RETRY_MS,
  PUSH_APPLY_DELAY_MS: () => PUSH_APPLY_DELAY_MS,
  RESUBSCRIBE_AFTER_COMMAND_MS: () => RESUBSCRIBE_AFTER_COMMAND_MS,
  STREAM_POLL_MS: () => STREAM_POLL_MS,
  merge: () => merge
});
module.exports = __toCommonJS(easee_service_exports);
var import_errors = require("../fuel/errors");
var import_failure_log = require("../util/failure-log");
var import_errors2 = require("./errors");
var import_objects = require("./objects");
var import_observations = require("./observations");
const MAX_BACKOFF_MS = 30 * 6e4;
const DISCOVERY_RETRY_MS = 6e4;
const AUTO_SELECT_MAX = 2;
const NO_CHARGER_RETRY_MS = 60 * 6e4;
const COMMAND_GAP_MS = 1e4;
const AFTER_COMMAND_POLLS_MS = [1e4, 4e4];
const COMMAND_SETTLE_MS = 6e4;
const STREAM_POLL_MS = 5 * 6e4;
const PUSH_APPLY_DELAY_MS = 1e3;
const RESUBSCRIBE_AFTER_COMMAND_MS = 15e3;
class EaseeService {
  /**
   * @param config - Validated Easee config (enabled)
   * @param deps - Dependencies
   */
  constructor(config, deps) {
    this.config = config;
    this.deps = deps;
  }
  failures = new import_failure_log.FailureLog();
  timers = /* @__PURE__ */ new Set();
  chargers = [];
  pollTimer;
  polling = false;
  pollAgain = false;
  failureCount = 0;
  stopped = false;
  stream;
  sessions;
  /** Last written value per state ID (writes only on change) */
  written = /* @__PURE__ */ new Map();
  /**
   * Adds the real-time stream (optional; without it the service only polls).
   *
   * @param stream - SignalR stream
   */
  attachStream(stream) {
    this.stream = stream;
  }
  /**
   * Adds the charging-session download (optional).
   *
   * @param sessions - Session part
   */
  attachSessions(sessions) {
    this.sessions = sessions;
  }
  /**
   * A value pushed by the stream.
   *
   * @param serial - Serial number
   * @param observation - Observation
   */
  pushObservation(serial, observation) {
    const charger = this.chargers.find((c) => c.serial === serial);
    if (!charger || this.stopped) {
      return;
    }
    merge(charger.observations, observation);
    if (!charger.applyPending) {
      charger.applyPending = true;
      this.schedule(() => {
        charger.applyPending = false;
        this.apply(charger).catch(
          (error) => this.deps.log.warn(`Easee: writing values failed: ${(0, import_errors.describeError)(error)}`)
        );
      }, PUSH_APPLY_DELAY_MS);
    }
  }
  /**
   * The stream went up or down.
   *
   * @param connected - New state
   */
  streamConnection(connected) {
    if (this.stopped) {
      return;
    }
    this.write(`${import_objects.EASEE_ROOT}.streamConnected`, connected).catch(() => void 0);
    if (!connected) {
      this.requestPoll(this.config.intervalSec * 1e3);
    }
  }
  /** Schedules the charger discovery shortly after the start */
  start() {
    this.deps.log.info(`Easee: reading chargers every ${this.config.intervalSec} s`);
    this.schedule(() => void this.discover(), 2e3 + Math.floor(this.deps.random() * 5e3));
  }
  /** Stops timers and running requests */
  stop() {
    var _a, _b;
    this.stopped = true;
    for (const handle of this.timers) {
      this.deps.clearTimeout(handle);
    }
    this.timers.clear();
    this.pollTimer = void 0;
    (_a = this.stream) == null ? void 0 : _a.stop();
    (_b = this.sessions) == null ? void 0 : _b.stop();
    this.deps.client.abort();
  }
  /** Slots of the known chargers (for tests and the adapter) */
  slots() {
    return this.chargers.map((charger) => charger.slot);
  }
  /** Reads the charger list and creates the objects; retries itself */
  async discover() {
    var _a;
    if (this.stopped) {
      return;
    }
    const { log } = this.deps;
    let list;
    try {
      list = await this.deps.client.getChargers();
    } catch (error) {
      const delay = this.handleFailure(error, DISCOVERY_RETRY_MS, "charger list");
      if (delay !== void 0) {
        this.schedule(() => void this.discover(), delay);
      }
      return;
    }
    this.recovered();
    if (list.length === 0) {
      log.warn("Easee: no chargers in this account - next check in 1 h");
      this.schedule(() => void this.discover(), NO_CHARGER_RETRY_MS);
      return;
    }
    const selected = this.select(list);
    if (selected.length === 0) {
      return;
    }
    this.chargers = selected.map(({ slot, info }) => ({
      slot,
      serial: info.serial,
      name: info.name || `Charger ${slot}`,
      state: void 0,
      lastCommandAt: 0,
      observations: /* @__PURE__ */ new Map(),
      applyPending: false,
      carConnected: null
    }));
    const definitions = (0, import_objects.rootObjects)();
    for (const charger of this.chargers) {
      definitions.push(...(0, import_objects.chargerObjects)(charger.slot, charger.name, this.config.pricePerKwh > 0));
    }
    await this.deps.ensureObjects(definitions);
    await this.deps.removeChargersExcept(this.slots());
    for (const charger of this.chargers) {
      await this.write(`${(0, import_objects.chargerChannel)(charger.slot)}.name`, charger.name);
    }
    log.info(
      `Easee: using ${this.chargers.map((c) => `charger${c.slot} = "${c.name}"`).join(", ")}${list.length > this.chargers.length ? ` (${list.length - this.chargers.length} other charger(s) ignored)` : ""}`
    );
    (_a = this.stream) == null ? void 0 : _a.start(this.chargers.map((c) => c.serial));
    if (this.sessions) {
      await this.sessions.start(this.chargers.map((c) => ({ slot: c.slot, serial: c.serial, name: c.name }))).catch((error) => log.warn(`Easee: charging sessions not available: ${(0, import_errors.describeError)(error)}`));
    }
    await this.poll();
  }
  /**
   * Picks the chargers to use: the names from the settings (fixed slots), or - without a
   * selection - all chargers if there are at most AUTO_SELECT_MAX.
   *
   * @param list - All chargers of the account
   */
  select(list) {
    const { log } = this.deps;
    const names = this.config.chargerNames;
    const available = () => list.map((c) => `"${c.name}"`).join(", ");
    if (names.every((name) => name === "")) {
      if (list.length <= AUTO_SELECT_MAX) {
        return list.map((info, index) => ({ slot: index + 1, info }));
      }
      log.warn(
        `Easee: this account sees ${list.length} chargers - please enter the names of yours in the instance settings (Easee tab). Nothing is read or switched until then. Chargers: ${available()}`
      );
      return [];
    }
    const result = [];
    names.forEach((name, index) => {
      if (!name) {
        return;
      }
      const matches = list.filter((c) => c.name.toLowerCase() === name.toLowerCase());
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
  requestPoll(delayMs = 0) {
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
  async poll() {
    var _a;
    if (this.stopped) {
      return;
    }
    if (this.polling) {
      this.pollAgain = true;
      return;
    }
    this.polling = true;
    const intervalMs = this.config.intervalSec * 1e3;
    const normalMs = ((_a = this.stream) == null ? void 0 : _a.isConnected()) ? Math.max(intervalMs, STREAM_POLL_MS) : intervalMs;
    let nextDelay = normalMs + Math.floor(this.deps.random() * 5e3);
    try {
      for (const charger of this.chargers) {
        for (const observation of await this.deps.client.getObservations(charger.serial)) {
          merge(charger.observations, observation);
        }
        await this.apply(charger);
      }
      this.recovered();
    } catch (error) {
      nextDelay = this.handleFailure(error, intervalMs, "reading values");
    } finally {
      this.polling = false;
    }
    if (nextDelay === void 0 || this.stopped) {
      return;
    }
    if (this.pollAgain) {
      this.pollAgain = false;
      nextDelay = Math.min(nextDelay, 1e3);
    }
    this.requestPoll(nextDelay);
  }
  /**
   * Start (true) or stop (false) charging, triggered by a write to charger<N>.charge.
   *
   * @param slot - Charger slot
   * @param on - true = start/resume, false = stop/pause
   */
  async setCharging(slot, on) {
    const { log } = this.deps;
    const charger = this.chargers.find((c) => c.slot === slot);
    if (!charger || this.stopped) {
      log.warn(`Easee: charger ${slot} is not available, command ignored`);
      return;
    }
    const id = `${(0, import_objects.chargerChannel)(slot)}.charge`;
    const now = this.deps.now();
    const st = charger.state;
    const actual = (st == null ? void 0 : st.opMode) === import_observations.OP_MODE.charging;
    if (now - charger.lastCommandAt < COMMAND_GAP_MS) {
      log.warn(`Easee: ${charger.name}: commands too fast, please wait a few seconds`);
      await this.write(id, actual);
      return;
    }
    if (on && ((st == null ? void 0 : st.opMode) === import_observations.OP_MODE.offline || (st == null ? void 0 : st.opMode) === import_observations.OP_MODE.disconnected || (st == null ? void 0 : st.online) === false)) {
      log.warn(
        `Easee: ${charger.name}: cannot start - ${(st == null ? void 0 : st.online) === false ? "offline" : "no car plugged in"}`
      );
      await this.write(id, actual);
      return;
    }
    const command = (st == null ? void 0 : st.authorizationRequired) === true ? on ? "start_charging" : "stop_charging" : on ? "resume_charging" : "pause_charging";
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
      if (error instanceof import_errors2.EaseeAbortedError) {
        return;
      }
      if (error instanceof import_errors2.EaseeAuthError) {
        this.handleFailure(error, 0, command);
      } else {
        log.warn(`Easee: ${charger.name}: ${command} failed: ${(0, import_errors.describeError)(error)}`);
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
  async write(id, value) {
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
  async apply(charger) {
    var _a;
    const st = (0, import_observations.parseChargerState)([...charger.observations.values()]);
    charger.state = st;
    const ch = (0, import_objects.chargerChannel)(charger.slot);
    const set = async (key, value) => {
      if (value !== null && value !== void 0) {
        await this.write(`${ch}.${key}`, value);
      }
    };
    await set("online", st.online);
    await set("opMode", st.opMode);
    await set("status", st.opMode === null ? null : import_observations.OP_MODE_STATES[st.opMode]);
    const connected = (0, import_observations.isCarConnected)(st.opMode);
    await set("carConnected", connected);
    if (connected !== null) {
      if (charger.carConnected === true && !connected) {
        (_a = this.sessions) == null ? void 0 : _a.carUnplugged(charger.slot);
      }
      charger.carConnected = connected;
    }
    await set("charging", st.opMode === null ? null : st.opMode === import_observations.OP_MODE.charging);
    await set("power", st.power);
    await set("sessionEnergy", st.sessionEnergy);
    await set("lifetimeEnergy", st.lifetimeEnergy);
    await set("dynamicCurrent", st.dynamicCurrent);
    await set("maxCurrent", st.maxCurrent);
    await set("outputCurrent", st.outputCurrent);
    await set("phaseMode", st.phaseMode);
    await set("cableLocked", st.cableLocked);
    await set("smartCharging", st.smartCharging);
    await set("authorizationRequired", st.authorizationRequired);
    await set("enabled", st.enabled);
    await set("reasonForNoCurrent", st.reasonForNoCurrent);
    await set("reasonText", (0, import_observations.reasonText)(st.reasonForNoCurrent) || null);
    await set("errorCode", st.errorCode);
    await set("lastUpdate", st.latestPulse);
    if (this.config.pricePerKwh > 0 && st.sessionEnergy !== null) {
      await set("sessionCost", Math.round(st.sessionEnergy * this.config.pricePerKwh * 100) / 100);
    }
    if (st.opMode !== null && this.deps.now() - charger.lastCommandAt >= COMMAND_SETTLE_MS) {
      await set("charge", st.opMode === import_observations.OP_MODE.charging);
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
  handleFailure(error, baseMs, what) {
    if (error instanceof import_errors2.EaseeAbortedError || this.stopped) {
      return void 0;
    }
    this.deps.onConnection(false);
    if (error instanceof import_errors2.EaseeAuthError) {
      this.deps.log.error(
        `Easee: ${(0, import_errors.describeError)(error)} - Easee stopped, please check the login in the instance settings`
      );
      this.stop();
      return void 0;
    }
    this.failureCount++;
    let delay = Math.min(Math.max(baseMs, 1e3) * 2 ** (this.failureCount - 1), MAX_BACKOFF_MS);
    if (error instanceof import_errors2.EaseeRateLimitedError) {
      delay = Math.max(delay, error.waitMs);
    }
    const level = this.failures.failed(this.deps.now());
    this.deps.log[level](`Easee: ${what} failed: ${(0, import_errors.describeError)(error)}; next try in ${(0, import_failure_log.formatDuration)(delay)}`);
    return delay;
  }
  /** Resets the backoff after a success */
  recovered() {
    this.failureCount = 0;
    const outage = this.failures.recovered(this.deps.now());
    if (outage !== void 0) {
      this.deps.log.info(`Easee reachable again (outage ${(0, import_failure_log.formatDuration)(outage)})`);
    }
    this.deps.onConnection(true);
  }
  /**
   * Replaces the pending poll timer.
   *
   * @param delayMs - Delay in ms
   */
  schedulePoll(delayMs) {
    if (this.pollTimer) {
      this.deps.clearTimeout(this.pollTimer.handle);
      this.timers.delete(this.pollTimer.handle);
    }
    const at = this.deps.now() + delayMs;
    const handle = this.schedule(() => {
      this.pollTimer = void 0;
      void this.poll();
    }, delayMs);
    this.pollTimer = { handle, at };
  }
  /**
   * @param callback - Work
   * @param ms - Delay
   */
  schedule(callback, ms) {
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
function merge(map, observation) {
  const old = map.get(observation.id);
  if (old && Date.parse(observation.timestamp) < Date.parse(old.timestamp)) {
    return;
  }
  map.set(observation.id, observation);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AFTER_COMMAND_POLLS_MS,
  AUTO_SELECT_MAX,
  COMMAND_GAP_MS,
  COMMAND_SETTLE_MS,
  DISCOVERY_RETRY_MS,
  EaseeService,
  MAX_BACKOFF_MS,
  NO_CHARGER_RETRY_MS,
  PUSH_APPLY_DELAY_MS,
  RESUBSCRIBE_AFTER_COMMAND_MS,
  STREAM_POLL_MS,
  merge
});
//# sourceMappingURL=easee-service.js.map
