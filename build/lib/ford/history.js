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
var history_exports = {};
__export(history_exports, {
  CHARGE_KWH: () => CHARGE_KWH,
  DAY_RECORDS: () => DAY_RECORDS,
  LONG_TRIP_KM: () => LONG_TRIP_KM,
  MAX_REFUELS: () => MAX_REFUELS,
  REFUEL_PCT: () => REFUEL_PCT,
  SAMPLE_DAYS: () => SAMPLE_DAYS,
  TYRE_TREND_MIN_DAYS: () => TYRE_TREND_MIN_DAYS,
  VehicleHistory: () => VehicleHistory,
  dayKey: () => dayKey,
  normaliseTyre: () => normaliseTyre,
  weekKey: () => weekKey
});
module.exports = __toCommonJS(history_exports);
const LONG_TRIP_KM = 50;
const SAMPLE_DAYS = 8;
const DAY_RECORDS = 400;
const MAX_REFUELS = 30;
const REFUEL_PCT = 10;
const CHARGE_KWH = 0.3;
const TYRE_TREND_MIN_DAYS = 3;
const DAY = 864e5;
const VERSION = 1;
function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function weekKey(d) {
  const [y, m, day] = d.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / DAY + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
function normaliseTyre(kpa, tempC) {
  return (kpa + 101.3) * (293.15 / (tempC + 273.15)) - 101.3;
}
function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function round(n, digits = 1) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
class VehicleHistory {
  samples = [];
  days = /* @__PURE__ */ new Map();
  refuels = [];
  trip = null;
  /**
   * Restores a stored history; invalid text gives an empty history.
   *
   * @param text - Stored JSON or undefined
   */
  static parse(text) {
    const history = new VehicleHistory();
    if (!text) {
      return { history, ok: true };
    }
    try {
      const data = JSON.parse(text);
      if (data.version !== VERSION) {
        return { history, ok: false };
      }
      history.samples = Array.isArray(data.samples) ? data.samples.filter((s) => typeof (s == null ? void 0 : s.t) === "number") : [];
      for (const day of Array.isArray(data.days) ? data.days : []) {
        if (typeof (day == null ? void 0 : day.d) === "string") {
          history.days.set(day.d, day);
        }
      }
      history.refuels = Array.isArray(data.refuels) ? data.refuels.filter((r) => typeof (r == null ? void 0 : r.t) === "number") : [];
      history.trip = data.trip && typeof data.trip.km === "number" ? data.trip : null;
      return { history, ok: true };
    } catch {
      return { history, ok: false };
    }
  }
  /** JSON for the file */
  serialize() {
    return JSON.stringify({
      version: VERSION,
      samples: this.samples,
      days: [...this.days.values()],
      refuels: this.refuels,
      trip: this.trip
    });
  }
  /**
   * Adds one poll. Samples with the same vehicle time as the last one are ignored
   * (the vehicle did not report anything new).
   *
   * @param s - Sample
   */
  add(s) {
    var _a, _b;
    const prev = this.samples[this.samples.length - 1];
    if (prev && s.t <= prev.t) {
      return;
    }
    const day = this.day(dayKey(s.t));
    if (s.temp !== null) {
      day.tempSum += s.temp;
      day.tempN++;
    }
    if (prev) {
      const dOdo = s.odo !== null && prev.odo !== null ? s.odo - prev.odo : 0;
      const moved = dOdo > 0 && dOdo < 2e3;
      if (moved) {
        day.km += dOdo;
        (_a = this.trip) != null ? _a : this.trip = { km: 0, parts: {} };
        this.trip.km += dOdo;
        this.trip.parts[day.d] = ((_b = this.trip.parts[day.d]) != null ? _b : 0) + dOdo;
      } else {
        this.closeTrip();
      }
      if (s.energy !== null && prev.energy !== null) {
        const dE = s.energy - prev.energy;
        if (moved && dE < 0) {
          day.kwhUsed += -dE;
          day.kmEv += dOdo;
        } else if (dE >= CHARGE_KWH) {
          day.kwhCharged += dE;
        }
      }
      if (s.fuel !== null && prev.fuel !== null && s.fuel - prev.fuel >= REFUEL_PCT) {
        const pct = s.fuel - prev.fuel;
        day.fuelPct += pct;
        this.refuels.push({ t: s.t, pct: round(pct), odo: s.odo });
        this.refuels.splice(0, Math.max(0, this.refuels.length - MAX_REFUELS));
      }
    }
    this.samples.push(s);
    this.prune(s.t);
  }
  /**
   * Pressure loss over the last 7 days per wheel in kPa (temperature-corrected),
   * only wheels that lost pressure; empty while there is too little data.
   *
   * @param now - Current time
   */
  tyreLoss(now) {
    const window = this.samples.filter((s) => s.t >= now - 7 * DAY && s.temp !== null);
    if (window.length < 2 || window[window.length - 1].t - window[0].t < TYRE_TREND_MIN_DAYS * DAY) {
      return {};
    }
    const first = window[0].t;
    const last = window[window.length - 1].t;
    const result = {};
    const wheels = new Set(window.flatMap((s) => Object.keys(s.tyres)));
    for (const wheel of wheels) {
      const values = (from, to) => window.filter((s) => s.t >= from && s.t <= to && typeof s.tyres[wheel] === "number").map((s) => normaliseTyre(s.tyres[wheel], s.temp));
      const before = values(first, first + DAY);
      const after = values(last - DAY, last);
      if (before.length && after.length) {
        const loss = median(before) - median(after);
        if (loss > 0) {
          result[wheel] = round(loss);
        }
      }
    }
    return result;
  }
  /**
   * Last weeks (oldest first, current week included).
   *
   * @param now - Current time
   * @param count - Number of weeks
   * @param tankLitres - Tank size (0 = unknown)
   */
  weeks(now, count, tankLitres) {
    const keys = [];
    for (let i = count - 1; i >= 0; i--) {
      const key = weekKey(dayKey(now - i * 7 * DAY));
      if (!keys.includes(key)) {
        keys.push(key);
      }
    }
    return keys.map((key) => this.summary(key, (d) => weekKey(d) === key, tankLitres));
  }
  /**
   * Last months (oldest first, current month included).
   *
   * @param now - Current time
   * @param count - Number of months
   * @param tankLitres - Tank size (0 = unknown)
   */
  months(now, count, tankLitres) {
    const date = new Date(now);
    const keys = [];
    for (let i = count - 1; i >= 0; i--) {
      const m = new Date(date.getFullYear(), date.getMonth() - i, 1);
      keys.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`);
    }
    return keys.map((key) => this.summary(key, (d) => d.startsWith(key), tankLitres));
  }
  /**
   * Fuel consumption from the last refuels in l/100 km (needs tank size and odometer), null if unknown.
   *
   * @param tankLitres - Tank size
   */
  fuelConsumption(tankLitres) {
    if (tankLitres <= 0) {
      return null;
    }
    let litres = 0;
    let km = 0;
    const list = this.refuels.slice(-6);
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1].odo;
      const b = list[i].odo;
      if (a !== null && b !== null && b > a) {
        litres += list[i].pct / 100 * tankLitres;
        km += b - a;
      }
    }
    return km >= 100 ? round(litres / km * 100) : null;
  }
  /** Last refuel or null */
  lastRefuel() {
    var _a;
    return (_a = this.refuels[this.refuels.length - 1]) != null ? _a : null;
  }
  /**
   * @param period - Key
   * @param match - Day filter
   * @param tankLitres - Tank size
   */
  summary(period, match, tankLitres) {
    const sum = { km: 0, longKm: 0, kwhUsed: 0, kmEv: 0, kwhCharged: 0, fuelPct: 0, tempSum: 0, tempN: 0 };
    for (const day of this.days.values()) {
      if (match(day.d)) {
        for (const key of Object.keys(sum)) {
          sum[key] += day[key];
        }
      }
    }
    return {
      period,
      km: Math.round(sum.km),
      longKm: Math.round(sum.longKm),
      kwhPer100: sum.kmEv >= 20 ? round(sum.kwhUsed / sum.kmEv * 100) : null,
      kwhUsed: round(sum.kwhUsed),
      kmEv: Math.round(sum.kmEv),
      kwhCharged: round(sum.kwhCharged),
      litres: tankLitres > 0 ? round(sum.fuelPct / 100 * tankLitres) : null,
      fuelPct: round(sum.fuelPct),
      temp: sum.tempN ? round(sum.tempSum / sum.tempN) : null
    };
  }
  /** Ends the running trip and books long-distance km */
  closeTrip() {
    if (this.trip && this.trip.km > LONG_TRIP_KM) {
      for (const [d, km] of Object.entries(this.trip.parts)) {
        this.day(d).longKm += km;
      }
    }
    this.trip = null;
  }
  /**
   * @param d - Day key
   */
  day(d) {
    let rec = this.days.get(d);
    if (!rec) {
      rec = { d, km: 0, longKm: 0, kwhUsed: 0, kmEv: 0, kwhCharged: 0, fuelPct: 0, tempSum: 0, tempN: 0 };
      this.days.set(d, rec);
    }
    return rec;
  }
  /**
   * @param now - Time of the newest sample
   */
  prune(now) {
    this.samples = this.samples.filter((s) => s.t >= now - SAMPLE_DAYS * DAY);
    if (this.days.size > DAY_RECORDS) {
      const keys = [...this.days.keys()].sort();
      for (const key of keys.slice(0, keys.length - DAY_RECORDS)) {
        this.days.delete(key);
      }
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CHARGE_KWH,
  DAY_RECORDS,
  LONG_TRIP_KM,
  MAX_REFUELS,
  REFUEL_PCT,
  SAMPLE_DAYS,
  TYRE_TREND_MIN_DAYS,
  VehicleHistory,
  dayKey,
  normaliseTyre,
  weekKey
});
//# sourceMappingURL=history.js.map
