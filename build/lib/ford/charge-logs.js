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
var charge_logs_exports = {};
__export(charge_logs_exports, {
  CHARGE_LOG_HOUR: () => CHARGE_LOG_HOUR,
  MAX_LOG_CHARS: () => MAX_LOG_CHARS,
  chargeLogDue: () => chargeLogDue,
  countEntries: () => countEntries,
  isoDay: () => isoDay,
  sanitizeChargeLogs: () => sanitizeChargeLogs
});
module.exports = __toCommonJS(charge_logs_exports);
const PRIVATE_KEY = /^(vin|deviceid|vehicleid|latitude|longitude|lat|lon|lng|geohash|address|address1|address2|street|city|postalcode|zip|name|userid|email)$/i;
const MAX_LOG_CHARS = 6e4;
function sanitizeChargeLogs(value, depth = 0) {
  if (depth > 8) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeChargeLogs(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (!PRIVATE_KEY.test(key)) {
        out[key] = sanitizeChargeLogs(item, depth + 1);
      }
    }
    return out;
  }
  return value;
}
function countEntries(value) {
  if (Array.isArray(value)) {
    return value.length;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      if (Array.isArray(item)) {
        return item.length;
      }
    }
  }
  return 0;
}
function isoDay(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const CHARGE_LOG_HOUR = 4;
function chargeLogDue(lastAt, now) {
  const d = new Date(now);
  const slot = new Date(d.getFullYear(), d.getMonth(), d.getDate(), CHARGE_LOG_HOUR).getTime();
  const latest = now >= slot ? slot : new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, CHARGE_LOG_HOUR).getTime();
  return lastAt < latest;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CHARGE_LOG_HOUR,
  MAX_LOG_CHARS,
  chargeLogDue,
  countEntries,
  isoDay,
  sanitizeChargeLogs
});
//# sourceMappingURL=charge-logs.js.map
