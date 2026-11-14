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
var config_exports = {};
__export(config_exports, {
  CHARGER_SLOTS: () => CHARGER_SLOTS,
  DEFAULT_INTERVAL_SEC: () => DEFAULT_INTERVAL_SEC,
  DEFAULT_PRICE_PER_KWH: () => DEFAULT_PRICE_PER_KWH,
  MAX_INTERVAL_SEC: () => MAX_INTERVAL_SEC,
  MIN_INTERVAL_SEC: () => MIN_INTERVAL_SEC,
  parseLocalDate: () => parseLocalDate,
  readEaseeConfig: () => readEaseeConfig
});
module.exports = __toCommonJS(config_exports);
const MIN_INTERVAL_SEC = 30;
const MAX_INTERVAL_SEC = 600;
const DEFAULT_INTERVAL_SEC = 60;
const CHARGER_SLOTS = 2;
const DEFAULT_PRICE_PER_KWH = 0.35;
function readEaseeConfig(native) {
  const problems = [];
  const userName = typeof native.easeeUser === "string" ? native.easeeUser.trim() : "";
  const password = typeof native.easeePassword === "string" ? native.easeePassword.replace(/[\r\n]/g, "") : "";
  let intervalSec = Number(native.easeeInterval);
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
    intervalSec = DEFAULT_INTERVAL_SEC;
  }
  intervalSec = Math.min(Math.max(Math.round(intervalSec), MIN_INTERVAL_SEC), MAX_INTERVAL_SEC);
  let pricePerKwh = native.easeePrice === void 0 ? DEFAULT_PRICE_PER_KWH : Number(native.easeePrice);
  if (!Number.isFinite(pricePerKwh) || pricePerKwh < 0 || pricePerKwh > 5) {
    problems.push("electricity price must be between 0 and 5 EUR/kWh - charging costs are off");
    pricePerKwh = 0;
  }
  const wanted = native.easeeEnabled === true;
  if (wanted && (!userName || !password)) {
    problems.push("user name or password missing - Easee stays off");
  }
  if (wanted && /^0?\d{6,}$/.test(userName.replace(/[\s/-]/g, ""))) {
    problems.push("the user name looks like a phone number without country code - use e.g. +49...");
  }
  const sessionsFrom = parseLocalDate(native.easeeSessionsFrom);
  if (sessionsFrom === void 0) {
    problems.push('"charging sessions from" must be a date like 2026-06-01 - all sessions are used');
  }
  const raw = [native.easeeCharger1, native.easeeCharger2];
  const chargerNames = [];
  for (let i = 0; i < CHARGER_SLOTS; i++) {
    const name = typeof raw[i] === "string" ? raw[i].trim() : "";
    if (name && chargerNames.some((other) => other.toLowerCase() === name.toLowerCase())) {
      problems.push(`charger ${i + 1} has the same name as another charger - ignored`);
      chargerNames.push("");
      continue;
    }
    chargerNames.push(name);
  }
  return {
    config: {
      enabled: wanted && userName !== "" && password !== "",
      userName,
      password,
      intervalSec,
      pricePerKwh: Math.round(pricePerKwh * 1e4) / 1e4,
      stream: native.easeeStream !== false,
      sessionsFrom: sessionsFrom != null ? sessionsFrom : null,
      chargerNames
    },
    problems
  };
}
function parseLocalDate(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") {
    return null;
  }
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const de = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text);
  const [y, m, d] = iso ? [Number(iso[1]), Number(iso[2]), Number(iso[3])] : de ? [Number(de[3]), Number(de[2]), Number(de[1])] : [NaN, NaN, NaN];
  const date = new Date(y, m - 1, d);
  if (!Number.isFinite(date.getTime()) || date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
    return void 0;
  }
  return date.getTime();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CHARGER_SLOTS,
  DEFAULT_INTERVAL_SEC,
  DEFAULT_PRICE_PER_KWH,
  MAX_INTERVAL_SEC,
  MIN_INTERVAL_SEC,
  parseLocalDate,
  readEaseeConfig
});
//# sourceMappingURL=config.js.map
