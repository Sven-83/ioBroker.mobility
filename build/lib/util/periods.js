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
var periods_exports = {};
__export(periods_exports, {
  dayKey: () => dayKey,
  lastMonthKeys: () => lastMonthKeys,
  lastWeekKeys: () => lastWeekKeys,
  weekKey: () => weekKey
});
module.exports = __toCommonJS(periods_exports);
const DAY = 864e5;
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
function lastWeekKeys(now, count) {
  const keys = [];
  for (let i = count - 1; i >= 0; i--) {
    const key = weekKey(dayKey(now - i * 7 * DAY));
    if (!keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys;
}
function lastMonthKeys(now, count) {
  const date = new Date(now);
  const keys = [];
  for (let i = count - 1; i >= 0; i--) {
    const m = new Date(date.getFullYear(), date.getMonth() - i, 1);
    keys.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`);
  }
  return keys;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  dayKey,
  lastMonthKeys,
  lastWeekKeys,
  weekKey
});
//# sourceMappingURL=periods.js.map
