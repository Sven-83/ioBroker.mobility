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
var fuel_service_exports = {};
__export(fuel_service_exports, {
  DETAIL_MAX_AGE_MS: () => DETAIL_MAX_AGE_MS,
  FUEL: () => FUEL,
  FuelService: () => FuelService,
  MAX_BACKOFF_MS: () => MAX_BACKOFF_MS,
  REFUSED_PAUSE_MS: () => REFUSED_PAUSE_MS,
  REQUEST_GAP_MS: () => REQUEST_GAP_MS
});
module.exports = __toCommonJS(fuel_service_exports);
var import_errors = require("./errors");
var import_objects = require("./objects");
var import_price_history = require("./price-history");
var import_rating = require("./rating");
var import_failure_log = require("../util/failure-log");
const FUEL = "e10";
const REQUEST_GAP_MS = 61e3;
const MAX_BACKOFF_MS = 60 * 6e4;
const REFUSED_PAUSE_MS = 60 * 6e4;
const DETAIL_MAX_AGE_MS = 24 * 36e5;
class FuelService {
  /**
   * @param config - Validated fuel config (enabled)
   * @param deps - Dependencies
   */
  constructor(config, deps) {
    this.config = config;
    this.deps = deps;
  }
  history = new import_price_history.PriceHistory();
  failures = new import_failure_log.FailureLog();
  timers = /* @__PURE__ */ new Set();
  detailFetched = /* @__PURE__ */ new Map();
  missingReported = /* @__PURE__ */ new Set();
  nextRequestAt = 0;
  failureCount = 0;
  stopped = false;
  /** Creates the objects, loads the memory and schedules the first poll */
  async start() {
    const { log } = this.deps;
    const loaded = import_price_history.PriceHistory.parse(await this.deps.loadHistory().catch(() => void 0));
    if (!loaded.valid) {
      log.warn("Fuel price memory could not be read, starting with an empty 7-day history");
    }
    this.history = loaded.history;
    const definitions = (0, import_objects.rootObjects)();
    for (const station of this.config.stations) {
      definitions.push(...(0, import_objects.stationObjects)(station.slot, station.name));
    }
    await this.deps.ensureObjects(definitions);
    await this.deps.removeStationsExcept(this.config.stations.map((station) => station.slot));
    for (const station of this.config.stations) {
      await this.deps.setState(`${(0, import_objects.stationChannel)(station.slot)}.name`, station.name);
    }
    const firstDelay = 5e3 + Math.floor(this.deps.random() * 6e4);
    log.info(
      `Fuel prices: ${this.config.stations.length} station(s), every ${this.config.intervalMin} min, Super E10; first request in ${Math.round(firstDelay / 1e3)} s`
    );
    this.schedule(() => void this.pollPrices(), firstDelay);
  }
  /** Stops timers and running requests (adapter unload / config change) */
  stop() {
    this.stopped = true;
    for (const handle of this.timers) {
      this.deps.clearTimeout(handle);
    }
    this.timers.clear();
    this.deps.client.abort();
  }
  /** One price cycle; schedules the next one itself */
  async pollPrices() {
    if (this.stopped) {
      return;
    }
    const { log } = this.deps;
    const intervalMs = this.config.intervalMin * 6e4;
    let nextDelay = intervalMs;
    try {
      await this.gate();
      const prices = await this.deps.client.getPrices(this.config.stations.map((station) => station.id));
      await this.applyPrices(prices);
      this.failureCount = 0;
      const outage = this.failures.recovered(this.deps.now());
      if (outage !== void 0) {
        log.info(`Tankerkoenig reachable again (outage ${(0, import_failure_log.formatDuration)(outage)})`);
      }
      this.deps.onConnection(true);
      this.scheduleDetails();
    } catch (error) {
      if (error instanceof import_errors.FuelAbortedError || this.stopped) {
        return;
      }
      this.deps.onConnection(false);
      if (error instanceof import_errors.FuelKeyRejectedError) {
        log.error(
          `${(0, import_errors.describeError)(error)} - fuel prices stopped, please check the key in the instance settings`
        );
        return;
      }
      this.failureCount++;
      nextDelay = Math.min(intervalMs * 2 ** (this.failureCount - 1), Math.max(MAX_BACKOFF_MS, intervalMs));
      if (error instanceof import_errors.FuelRateLimitedError) {
        nextDelay = Math.max(nextDelay, error.waitMs);
      }
      if (error instanceof import_errors.FuelRefusedError) {
        nextDelay = Math.max(nextDelay, REFUSED_PAUSE_MS);
        this.pause(REFUSED_PAUSE_MS);
      }
      const level = this.failures.failed(this.deps.now());
      log[level](`Fuel prices: ${(0, import_errors.describeError)(error)}; next try in ${(0, import_failure_log.formatDuration)(nextDelay)}`);
    }
    this.schedule(() => void this.pollPrices(), nextDelay + Math.floor(this.deps.random() * 6e4));
  }
  /**
   * Writes prices, memory and ratings.
   *
   * @param prices - Answer of prices.php
   */
  async applyPrices(prices) {
    var _a, _b, _c, _d;
    const now = this.deps.now();
    const ranking = [];
    for (const station of this.config.stations) {
      const ch = (0, import_objects.stationChannel)(station.slot);
      const entry = prices.get(station.id);
      if (!entry) {
        if (!this.missingReported.has(station.id)) {
          this.missingReported.add(station.id);
          this.deps.log.warn(
            `Fuel prices: station "${station.name}" is unknown to Tankerkoenig, check its ID`
          );
        }
        await this.deps.setState(`${ch}.status`, "not found");
        await this.deps.setState(`${ch}.open`, false);
        continue;
      }
      const open = entry.status === "open";
      await this.deps.setState(`${ch}.status`, entry.status);
      await this.deps.setState(`${ch}.open`, open);
      await this.deps.setState(`${ch}.lastUpdate`, now);
      const current = open ? entry.e10 : null;
      await this.deps.setState(`${ch}.e10`, current);
      const key = import_price_history.PriceHistory.key(station.id, FUEL);
      this.history.add(key, now, current);
      const result = (0, import_rating.evaluate)(this.history.points(key), current, now);
      await this.deps.setState(`${ch}.rating`, result.rating);
      await this.deps.setState(`${ch}.rank`, result.rank === null ? null : Math.round(result.rank * 100));
      await this.deps.setState(`${ch}.min7d`, result.min);
      await this.deps.setState(`${ch}.max7d`, result.max);
      await this.deps.setState(`${ch}.avg7d`, result.average);
      await this.deps.setState(`${ch}.coverage`, Math.round(result.coverageMs / 36e4) / 10);
      await this.deps.setState(`${ch}.bestHour`, result.bestHour);
      await this.deps.setState(`${ch}.bestHourPrice`, result.bestHourPrice);
      await this.deps.setState(`${ch}.bestWeekday`, result.bestWeekday);
      await this.deps.setState(`${ch}.bestWeekdayPrice`, result.bestWeekdayPrice);
      if (current !== null) {
        ranking.push({
          station: `station${station.slot}`,
          name: station.name,
          price: current,
          rating: result.rating
        });
      }
    }
    ranking.sort((a, b) => a.price - b.price);
    await this.deps.setState(`${import_objects.FUEL_ROOT}.ranking`, JSON.stringify(ranking));
    await this.deps.setState(`${import_objects.FUEL_ROOT}.cheapestStation`, (_b = (_a = ranking[0]) == null ? void 0 : _a.name) != null ? _b : "");
    await this.deps.setState(`${import_objects.FUEL_ROOT}.cheapestPrice`, (_d = (_c = ranking[0]) == null ? void 0 : _c.price) != null ? _d : null);
    const keep = new Set(this.config.stations.map((station) => import_price_history.PriceHistory.key(station.id, FUEL)));
    this.history.prune(now, keep);
    await this.deps.saveHistory(this.history.serialize()).catch((error) => {
      this.deps.log.warn(`Fuel price memory could not be saved: ${(0, import_errors.describeError)(error)}`);
    });
  }
  /** Fetches master data of the next station that needs it (one per gate slot) */
  scheduleDetails() {
    const now = this.deps.now();
    const due = this.config.stations.findIndex((station) => {
      const last = this.detailFetched.get(station.id);
      return last === void 0 || now - last > DETAIL_MAX_AGE_MS;
    });
    if (due === -1) {
      return;
    }
    this.schedule(() => void this.fetchDetail(due), 0);
  }
  /**
   * @param index - 0-based position in config.stations
   */
  async fetchDetail(index) {
    const station = this.config.stations[index];
    if (this.stopped || !station) {
      return;
    }
    this.detailFetched.set(station.id, this.deps.now());
    try {
      await this.gate();
      const detail = await this.deps.client.getDetail(station.id);
      const ch = (0, import_objects.stationChannel)(station.slot);
      await this.deps.setState(`${ch}.brand`, detail.brand);
      const street = [detail.street, detail.houseNumber].filter(Boolean).join(" ");
      const place = [detail.postCode, detail.place].filter(Boolean).join(" ");
      await this.deps.setState(`${ch}.address`, [street, place].filter(Boolean).join(", "));
    } catch (error) {
      if (error instanceof import_errors.FuelAbortedError || this.stopped) {
        return;
      }
      if (error instanceof import_errors.FuelRefusedError) {
        this.pause(REFUSED_PAUSE_MS);
        this.deps.log.warn(`Fuel prices: ${(0, import_errors.describeError)(error)}; no requests for 1 h`);
        return;
      }
      this.deps.log.debug(`Fuel prices: master data of "${station.name}" failed: ${(0, import_errors.describeError)(error)}`);
    }
    this.scheduleDetails();
  }
  /** Waits until the next request slot (reservation, so parallel callers queue up) */
  /**
   * Blocks all requests (prices and master data) for a while.
   *
   * @param ms - Pause in ms
   */
  pause(ms) {
    this.nextRequestAt = Math.max(this.nextRequestAt, this.deps.now() + ms);
  }
  async gate() {
    const now = this.deps.now();
    const slot = Math.max(now, this.nextRequestAt);
    this.nextRequestAt = slot + REQUEST_GAP_MS;
    const wait = slot - now;
    if (wait > 0) {
      await new Promise((resolve) => this.schedule(resolve, wait));
    }
    if (this.stopped) {
      throw new import_errors.FuelAbortedError("stopped");
    }
  }
  /**
   * @param callback - Function to run
   * @param ms - Delay
   */
  schedule(callback, ms) {
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DETAIL_MAX_AGE_MS,
  FUEL,
  FuelService,
  MAX_BACKOFF_MS,
  REFUSED_PAUSE_MS,
  REQUEST_GAP_MS
});
//# sourceMappingURL=fuel-service.js.map
