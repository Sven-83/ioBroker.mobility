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
var sessions_sync_exports = {};
__export(sessions_sync_exports, {
  AFTER_UNPLUG_MS: () => AFTER_UNPLUG_MS,
  BACKFILL_LIMIT: () => BACKFILL_LIMIT,
  BACKFILL_WINDOW_MS: () => BACKFILL_WINDOW_MS,
  DAYS: () => DAYS,
  EaseeSessions: () => EaseeSessions,
  FIRST_REQUEST_MS: () => FIRST_REQUEST_MS,
  MAX_BACKOFF_MS: () => MAX_BACKOFF_MS,
  MONTHS: () => MONTHS,
  RECENT_WINDOW_MS: () => RECENT_WINDOW_MS,
  REFRESH_MS: () => REFRESH_MS,
  REQUEST_GAP_MS: () => REQUEST_GAP_MS,
  WEEKS: () => WEEKS
});
module.exports = __toCommonJS(sessions_sync_exports);
var import_errors = require("../fuel/errors");
var import_errors2 = require("./errors");
var import_objects = require("./objects");
var import_sessions = require("./sessions");
const DAY = 864e5;
const REQUEST_GAP_MS = 6 * 6e4;
const FIRST_REQUEST_MS = 6e4;
const REFRESH_MS = 6 * 36e5;
const AFTER_UNPLUG_MS = 2 * 6e4;
const BACKFILL_WINDOW_MS = 365 * DAY;
const RECENT_WINDOW_MS = 30 * DAY;
const BACKFILL_LIMIT = Date.UTC(2016, 0, 1);
const MAX_BACKOFF_MS = 6 * 36e5;
const DAYS = 14;
const WEEKS = 12;
const MONTHS = 13;
class EaseeSessions {
  /**
   * @param pricePerKwh - Configured price, 0 = none
   * @param deps - Dependencies
   * @param since - Only sessions from this time on (epoch ms), null = all
   */
  constructor(pricePerKwh, deps, since = null) {
    this.pricePerKwh = pricePerKwh;
    this.deps = deps;
    this.limit = Math.max(BACKFILL_LIMIT, since != null ? since : BACKFILL_LIMIT);
  }
  entries = [];
  queue = [];
  timers = /* @__PURE__ */ new Set();
  runTimer;
  running = false;
  lastRequestAt = 0;
  failureCount = 0;
  stopped = false;
  /** Oldest time that is read and counted */
  limit;
  /** @inheritdoc */
  async start(chargers) {
    if (this.stopped) {
      return;
    }
    this.entries = [];
    for (const c of chargers) {
      const text = await this.deps.load(c.slot).catch(() => void 0);
      const store = import_sessions.SessionStore.parse(text);
      if (store.backfillDone && store.backfilledTo !== null && store.backfilledTo > this.limit) {
        store.backfillDone = false;
      }
      if (!store.backfillDone && store.backfilledTo !== null && store.backfilledTo <= this.limit) {
        store.backfillDone = true;
      }
      this.entries.push({ ...c, store, lastSync: null });
    }
    const definitions = (0, import_objects.historyObjects)(import_objects.EASEE_ROOT, this.pricePerKwh > 0);
    for (const e of this.entries) {
      definitions.push(...(0, import_objects.historyObjects)((0, import_objects.chargerChannel)(e.slot), this.pricePerKwh > 0));
    }
    await this.deps.ensureObjects(definitions);
    await this.writeStates();
    for (const e of this.entries) {
      this.enqueue({ slot: e.slot, kind: e.store.backfillDone ? "recent" : "backfill" });
    }
    this.scheduleRun(FIRST_REQUEST_MS);
    this.scheduleRefresh();
  }
  /** @inheritdoc */
  carUnplugged(slot) {
    if (this.stopped || !this.entries.some((e) => e.slot === slot)) {
      return;
    }
    this.schedule(() => {
      this.enqueue({ slot, kind: "recent" });
      this.scheduleRun(0);
    }, AFTER_UNPLUG_MS);
  }
  /** @inheritdoc */
  stop() {
    this.stopped = true;
    for (const handle of this.timers) {
      this.deps.clearTimeout(handle);
    }
    this.timers.clear();
    this.runTimer = void 0;
  }
  /** Pending tasks (tests) */
  pending() {
    return [...this.queue];
  }
  /** Works on the first task; schedules itself for the rest */
  async run() {
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
    const entry = this.entries.find((e) => e.slot === task.slot);
    if (!entry) {
      this.queue.shift();
      this.scheduleRun(0);
      return;
    }
    this.running = true;
    let nextDelay = 0;
    try {
      await this.work(entry, task);
      this.failureCount = 0;
      this.queue.shift();
      if (task.kind === "backfill" && !entry.store.backfillDone) {
        this.enqueue({ slot: entry.slot, kind: "backfill" });
      }
    } catch (error) {
      nextDelay = this.failed(error);
    } finally {
      this.running = false;
    }
    if (nextDelay !== void 0 && this.queue.length > 0) {
      this.scheduleRun(nextDelay);
    }
  }
  /**
   * One request and its results.
   *
   * @param entry - Charger
   * @param task - Task
   */
  async work(entry, task) {
    var _a;
    const now = this.deps.now();
    const { store } = entry;
    let from;
    let to;
    if (task.kind === "backfill") {
      to = (_a = store.backfilledTo) != null ? _a : now;
      from = Math.max(to - BACKFILL_WINDOW_MS, this.limit);
      if (from >= to) {
        store.backfillDone = true;
        return;
      }
    } else {
      to = now;
      from = Math.min(Math.max(now - RECENT_WINDOW_MS, this.limit), now - 36e5);
    }
    this.lastRequestAt = now;
    const sessions = await this.deps.getSessions(entry.serial, from, to);
    const changed = store.add(sessions);
    if (task.kind === "backfill") {
      store.backfilledTo = from;
      if (sessions.length === 0 || from <= this.limit) {
        store.backfillDone = true;
        const used = store.list().filter((s) => s.start >= this.limit);
        const oldest = used[0];
        this.deps.log.info(
          `Easee: ${entry.name}: ${used.length} charging session(s) loaded${oldest ? ` (since ${new Date(oldest.start).toISOString().slice(0, 10)})` : ""}`
        );
      } else {
        this.deps.log.debug(`Easee: ${entry.name}: ${sessions.length} older session(s) loaded`);
      }
    } else if (changed > 0) {
      this.deps.log.debug(`Easee: ${entry.name}: ${changed} new/changed session(s)`);
    }
    entry.lastSync = now;
    if (changed > 0 || task.kind === "backfill") {
      await this.deps.save(entry.slot, store.serialize()).catch((error) => this.deps.log.warn(`Easee: saving the sessions failed: ${(0, import_errors.describeError)(error)}`));
    }
    await this.writeStates();
  }
  /**
   * @param error - Thrown error
   * @returns Delay before the next try, undefined = stop
   */
  failed(error) {
    if (error instanceof import_errors2.EaseeAbortedError || this.stopped) {
      return void 0;
    }
    if (error instanceof import_errors2.EaseeAuthError) {
      this.stop();
      return void 0;
    }
    this.failureCount++;
    let delay = Math.min(REQUEST_GAP_MS * 2 ** (this.failureCount - 1), MAX_BACKOFF_MS);
    if (error instanceof import_errors2.EaseeRateLimitedError) {
      delay = Math.max(delay, error.waitMs);
    }
    const level = this.failureCount >= 3 ? "warn" : "debug";
    this.deps.log[level](
      `Easee: reading charging sessions failed: ${(0, import_errors.describeError)(error)}; next try in ${Math.round(delay / 6e4)} min`
    );
    return delay;
  }
  /** Writes the states of all chargers and the sums */
  async writeStates() {
    const now = this.deps.now();
    const all = [];
    for (const e of this.entries) {
      const list = e.store.list().filter((s) => s.start >= this.limit);
      all.push(...list);
      await this.writeReport((0, import_objects.chargerChannel)(e.slot), new import_sessions.SessionReport(list, this.pricePerKwh), now);
      await this.deps.setState(`${(0, import_objects.chargerChannel)(e.slot)}.history.sessionCount`, list.length);
      if (e.lastSync !== null) {
        await this.deps.setState(`${(0, import_objects.chargerChannel)(e.slot)}.history.lastSync`, e.lastSync);
      }
    }
    await this.writeReport(import_objects.EASEE_ROOT, new import_sessions.SessionReport(all, this.pricePerKwh), now);
    await this.deps.setState(`${import_objects.EASEE_ROOT}.history.sessionCount`, all.length);
  }
  /**
   * @param prefix - easee or easee.chargerN
   * @param report - Evaluation
   * @param now - Current time
   */
  async writeReport(prefix, report, now) {
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
  enqueue(task) {
    if (!this.queue.some((t) => t.slot === task.slot && t.kind === task.kind)) {
      this.queue.push(task);
    }
  }
  /** Regular update of all chargers */
  scheduleRefresh() {
    this.schedule(() => {
      for (const e of this.entries) {
        if (e.store.backfillDone) {
          this.enqueue({ slot: e.slot, kind: "recent" });
        }
      }
      this.scheduleRun(0);
      this.scheduleRefresh();
    }, REFRESH_MS);
  }
  /**
   * @param ms - Delay (earlier pending run wins only if it is not replaced)
   */
  scheduleRun(ms) {
    if (this.runTimer) {
      this.deps.clearTimeout(this.runTimer.handle);
      this.timers.delete(this.runTimer.handle);
    }
    const handle = this.schedule(() => {
      this.runTimer = void 0;
      void this.run();
    }, ms);
    this.runTimer = { handle };
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AFTER_UNPLUG_MS,
  BACKFILL_LIMIT,
  BACKFILL_WINDOW_MS,
  DAYS,
  EaseeSessions,
  FIRST_REQUEST_MS,
  MAX_BACKOFF_MS,
  MONTHS,
  RECENT_WINDOW_MS,
  REFRESH_MS,
  REQUEST_GAP_MS,
  WEEKS
});
//# sourceMappingURL=sessions-sync.js.map
