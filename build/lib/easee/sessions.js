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
var sessions_exports = {};
__export(sessions_exports, {
  SessionReport: () => SessionReport,
  SessionStore: () => SessionStore,
  parseSessions: () => parseSessions,
  sessionCost: () => sessionCost
});
module.exports = __toCommonJS(sessions_exports);
var import_periods = require("../util/periods");
const VERSION = 1;
function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
function time(value) {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}
function num(value) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
function parseSessions(body) {
  var _a;
  if (!Array.isArray(body)) {
    return void 0;
  }
  const result = [];
  for (const entry of body) {
    const raw = entry != null ? entry : {};
    const id = num(raw.id);
    const start = (_a = time(raw.carConnected)) != null ? _a : time(raw.firstEnergyTransferPeriodStarted);
    const kwh = num(raw.kiloWattHours);
    if (id === null || start === null || kwh === null || kwh < 0 || kwh > 1e3) {
      continue;
    }
    const cost = num(raw.costIncludingVat);
    const seconds = num(raw.actualDurationSeconds);
    result.push({
      id,
      start,
      end: time(raw.carDisconnected),
      kwh: round(kwh, 3),
      seconds: seconds !== null && seconds >= 0 ? Math.round(seconds) : null,
      easeeCost: cost !== null && cost > 0 ? round(cost, 2) : null,
      complete: raw.isComplete === true
    });
  }
  return result;
}
class SessionStore {
  byId = /* @__PURE__ */ new Map();
  /** Downloads reached back to this time (epoch ms), null = not started */
  backfilledTo = null;
  /** No older sessions exist */
  backfillDone = false;
  /**
   * @param text - Stored JSON, undefined = empty store
   */
  static parse(text) {
    const store = new SessionStore();
    if (!text) {
      return store;
    }
    try {
      const data = JSON.parse(text);
      if (data.v !== VERSION || !Array.isArray(data.sessions)) {
        return store;
      }
      for (const s of data.sessions) {
        if (typeof (s == null ? void 0 : s.id) === "number" && typeof s.start === "number" && typeof s.kwh === "number") {
          store.byId.set(s.id, {
            id: s.id,
            start: s.start,
            end: typeof s.end === "number" ? s.end : null,
            kwh: s.kwh,
            seconds: typeof s.seconds === "number" ? s.seconds : null,
            easeeCost: typeof s.easeeCost === "number" ? s.easeeCost : null,
            complete: s.complete === true
          });
        }
      }
      store.backfilledTo = typeof data.backfilledTo === "number" ? data.backfilledTo : null;
      store.backfillDone = data.backfillDone === true;
    } catch {
    }
    return store;
  }
  /** JSON for the file */
  serialize() {
    return JSON.stringify({
      v: VERSION,
      backfilledTo: this.backfilledTo,
      backfillDone: this.backfillDone,
      sessions: this.list()
    });
  }
  /**
   * Adds or updates sessions (same ID = newer download wins).
   *
   * @param sessions - Downloaded sessions
   * @returns Number of new or changed sessions
   */
  add(sessions) {
    let changed = 0;
    for (const s of sessions) {
      const old = this.byId.get(s.id);
      if (!old || JSON.stringify(old) !== JSON.stringify(s)) {
        this.byId.set(s.id, s);
        changed++;
      }
    }
    return changed;
  }
  /** Sessions sorted by start, oldest first */
  list() {
    return [...this.byId.values()].sort((a, b) => a.start - b.start);
  }
  /** Number of sessions */
  get size() {
    return this.byId.size;
  }
}
function sessionCost(s, pricePerKwh) {
  if (s.easeeCost !== null) {
    return s.easeeCost;
  }
  return pricePerKwh > 0 ? round(s.kwh * pricePerKwh, 2) : null;
}
class SessionReport {
  /**
   * @param sessions - Sessions (any order, several chargers allowed)
   * @param pricePerKwh - Configured price, 0 = none
   */
  constructor(sessions, pricePerKwh) {
    this.pricePerKwh = pricePerKwh;
    this.sessions = [...sessions].sort((a, b) => a.start - b.start);
  }
  sessions;
  /**
   * Last weeks, oldest first, current week included.
   *
   * @param now - Current time
   * @param count - Number of weeks
   */
  weeks(now, count) {
    return (0, import_periods.lastWeekKeys)(now, count).map((key) => this.sum(key, (s) => (0, import_periods.weekKey)((0, import_periods.dayKey)(s.start)) === key));
  }
  /**
   * Last months, oldest first, current month included.
   *
   * @param now - Current time
   * @param count - Number of months
   */
  months(now, count) {
    return (0, import_periods.lastMonthKeys)(now, count).map((key) => this.sum(key, (s) => (0, import_periods.dayKey)(s.start).startsWith(key)));
  }
  /**
   * One calendar year.
   *
   * @param year - e.g. 2026
   */
  year(year) {
    const key = String(year);
    return this.sum(key, (s) => (0, import_periods.dayKey)(s.start).startsWith(`${key}-`));
  }
  /** Newest session or null */
  last() {
    const s = this.sessions[this.sessions.length - 1];
    if (!s) {
      return null;
    }
    return {
      start: s.start,
      end: s.end,
      kwh: round(s.kwh, 2),
      cost: sessionCost(s, this.pricePerKwh),
      minutes: s.seconds === null ? null : Math.round(s.seconds / 60)
    };
  }
  /** Start of the oldest session or null */
  oldest() {
    var _a, _b;
    return (_b = (_a = this.sessions[0]) == null ? void 0 : _a.start) != null ? _b : null;
  }
  /**
   * @param period - Key
   * @param match - Filter
   */
  sum(period, match) {
    let sessions = 0;
    let kwh = 0;
    let cost = 0;
    let priced = true;
    for (const s of this.sessions) {
      if (!match(s)) {
        continue;
      }
      sessions++;
      kwh += s.kwh;
      const c = sessionCost(s, this.pricePerKwh);
      if (c === null) {
        priced = false;
      } else {
        cost += c;
      }
    }
    return {
      period,
      sessions,
      kwh: round(kwh, 1),
      cost: priced && (sessions > 0 || this.pricePerKwh > 0) ? round(cost, 2) : null
    };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SessionReport,
  SessionStore,
  parseSessions,
  sessionCost
});
//# sourceMappingURL=sessions.js.map
