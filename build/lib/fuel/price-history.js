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
var price_history_exports = {};
__export(price_history_exports, {
  FILE_VERSION: () => FILE_VERSION,
  MAX_POINTS_PER_SERIES: () => MAX_POINTS_PER_SERIES,
  PriceHistory: () => PriceHistory,
  WINDOW_MS: () => WINDOW_MS
});
module.exports = __toCommonJS(price_history_exports);
const WINDOW_MS = 7 * 24 * 36e5;
const MAX_POINTS_PER_SERIES = 5e3;
const FILE_VERSION = 1;
class PriceHistory {
  series = /* @__PURE__ */ new Map();
  /**
   * Key of a series.
   *
   * @param stationId - Station ID
   * @param fuel - Fuel type
   */
  static key(stationId, fuel) {
    return `${stationId.toLowerCase()}|${fuel}`;
  }
  /**
   * Records a sample; only stores it if the price changed.
   *
   * @param key - Series key
   * @param time - Time of the sample (epoch ms)
   * @param price - Price or null
   * @returns true if a new change point was stored
   */
  add(key, time, price) {
    let points = this.series.get(key);
    if (!points) {
      points = [];
      this.series.set(key, points);
    }
    const last = points[points.length - 1];
    if (last && (time < last[0] || last[1] === price)) {
      return false;
    }
    points.push([time, price]);
    if (points.length > MAX_POINTS_PER_SERIES) {
      points.splice(0, points.length - MAX_POINTS_PER_SERIES);
    }
    return true;
  }
  /**
   * Change points of one series (oldest first). The returned array must not be modified.
   *
   * @param key - Series key
   */
  points(key) {
    var _a;
    return (_a = this.series.get(key)) != null ? _a : [];
  }
  /**
   * Drops points that are no longer needed: everything before the window except the last point
   * before it (it defines the price at the window start). Removes series that are not wanted any more.
   *
   * @param now - Current time (epoch ms)
   * @param keepKeys - Series that are still configured
   */
  prune(now, keepKeys) {
    const start = now - WINDOW_MS;
    for (const [key, points] of this.series) {
      if (keepKeys && !keepKeys.has(key)) {
        this.series.delete(key);
        continue;
      }
      let firstInside = points.findIndex((point) => point[0] >= start);
      if (firstInside === -1) {
        firstInside = points.length;
      }
      if (firstInside > 1) {
        points.splice(0, firstInside - 1);
      }
    }
  }
  /** JSON for the instance file */
  serialize() {
    return JSON.stringify({ version: FILE_VERSION, series: Object.fromEntries(this.series) });
  }
  /**
   * Restores from the instance file. Invalid content results in an empty history (no crash).
   *
   * @param text - File content
   * @returns The history and whether the content was usable
   */
  static parse(text) {
    const history = new PriceHistory();
    if (!text) {
      return { history, valid: true };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { history, valid: false };
    }
    const file = data;
    if ((file == null ? void 0 : file.version) !== FILE_VERSION || typeof file.series !== "object" || file.series === null) {
      return { history, valid: false };
    }
    for (const [key, value] of Object.entries(file.series)) {
      if (!/^[0-9a-f-]{36}\|[a-z0-9]{1,10}$/.test(key) || !Array.isArray(value)) {
        continue;
      }
      for (const point of value) {
        if (Array.isArray(point) && typeof point[0] === "number" && Number.isFinite(point[0]) && (point[1] === null || typeof point[1] === "number" && Number.isFinite(point[1]))) {
          history.add(key, point[0], point[1]);
        }
      }
    }
    return { history, valid: true };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  FILE_VERSION,
  MAX_POINTS_PER_SERIES,
  PriceHistory,
  WINDOW_MS
});
//# sourceMappingURL=price-history.js.map
