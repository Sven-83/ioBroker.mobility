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
var warnings_exports = {};
__export(warnings_exports, {
  LIMITS: () => LIMITS,
  computeWarnings: () => computeWarnings,
  worstLevel: () => worstLevel
});
module.exports = __toCommonJS(warnings_exports);
var import_telemetry = require("./telemetry");
const LIMITS = {
  /** Unlocked with ignition off for longer than this counts */
  unlockedMs: 10 * 6e4,
  /** Tyre below this share of the placard pressure */
  tyreShare: 0.85,
  fuelWarn: 25,
  fuelCritical: 10,
  socWarn: 20,
  socCritical: 10,
  battery12vCritical: 25,
  oilWarn: 15,
  oilCritical: 5,
  /** "Not plugged in" from this hour on ... */
  plugHour: 20,
  /** ... when the battery is below this */
  plugSoc: 50,
  frostC: 3,
  staleMs: 12 * 36e5,
  loginMs: 14 * 24 * 36e5
};
const ORDER = { critical: 0, warning: 1, info: 2 };
const KEY_ORDER = [
  "alarm",
  "tyre",
  "unlocked",
  "door",
  "window",
  "chargeFault",
  "fuel",
  "battery",
  "battery12v",
  "oil",
  "tyreLoss",
  "notPluggedIn",
  "batteryPerformance",
  "frost",
  "stale",
  "login"
];
const CHARGE_FAULT = /FAULT|ERROR|ABORT|INTERRUPT|FAIL/;
function computeWarnings(st, ctx) {
  var _a, _b;
  const list = [];
  const add = (w) => {
    list.push(w);
  };
  const parked = st.ignition === null || st.ignition.toUpperCase() === "OFF";
  if (st.alarmTriggered) {
    add({ key: "alarm", level: "critical" });
  }
  for (const [wheel, pressure] of Object.entries(st.tires)) {
    const status = st.tireStatus[wheel];
    const placard = st.tirePlacard[wheel];
    const low = status !== void 0 && status !== "NORMAL" || placard !== void 0 && pressure < placard * LIMITS.tyreShare;
    if (low) {
      add({ key: "tyre", level: "critical", wheel, value: Math.round(pressure) / 100, unit: "bar" });
    }
  }
  if (parked && st.locked === false && ctx.unlockedSince !== null && ctx.now - ctx.unlockedSince >= LIMITS.unlockedMs) {
    add({ key: "unlocked", level: "critical" });
  }
  if (parked && (st.doorsClosed === false || st.hoodClosed === false)) {
    add({ key: "door", level: "critical" });
  }
  if (parked && st.windowsClosed === false) {
    add({ key: "window", level: "critical" });
  }
  if (st.chargeStatus && CHARGE_FAULT.test(st.chargeStatus.toUpperCase())) {
    add({ key: "chargeFault", level: "critical" });
  }
  const bev = (0, import_telemetry.isBev)(st);
  if (!bev && st.fuelLevel !== null && st.fuelLevel <= LIMITS.fuelWarn) {
    add({
      key: "fuel",
      level: st.fuelLevel <= LIMITS.fuelCritical ? "critical" : "warning",
      value: st.fuelLevel,
      unit: "%"
    });
  }
  if (bev && st.soc !== null && st.soc <= LIMITS.socWarn) {
    add({ key: "battery", level: st.soc <= LIMITS.socCritical ? "critical" : "warning", value: st.soc, unit: "%" });
  }
  if (st.battery12v !== null) {
    if (st.battery12v < import_telemetry.BATTERY_12V_LOW_PERCENT) {
      add({
        key: "battery12v",
        level: st.battery12v < LIMITS.battery12vCritical ? "critical" : "warning",
        value: st.battery12v,
        unit: "%"
      });
    }
  } else if (parked && st.battery12vVoltage !== null && st.battery12vVoltage < import_telemetry.BATTERY_12V_LOW_VOLT) {
    add({ key: "battery12v", level: "warning", value: st.battery12vVoltage, unit: "V" });
  }
  if (st.oilLife !== null && st.oilLife <= LIMITS.oilWarn) {
    add({
      key: "oil",
      level: st.oilLife <= LIMITS.oilCritical ? "critical" : "warning",
      value: st.oilLife,
      unit: "%"
    });
  }
  for (const [wheel, loss] of Object.entries((_a = ctx.tyreLoss) != null ? _a : {})) {
    if (loss >= 20 && !list.some((w) => w.key === "tyre" && w.wheel === wheel)) {
      add({ key: "tyreLoss", level: "warning", wheel, value: Math.round(loss) / 100, unit: "bar" });
    }
  }
  if (bev && ctx.hour >= LIMITS.plugHour && st.soc !== null && st.soc < LIMITS.plugSoc && ((_b = st.plugStatus) == null ? void 0 : _b.toUpperCase()) === "DISCONNECTED") {
    add({ key: "notPluggedIn", level: "warning", value: st.soc, unit: "%" });
  }
  if (st.batteryPerformance !== null && st.batteryPerformance !== "NORMAL") {
    add({ key: "batteryPerformance", level: "warning" });
  }
  if (st.outsideTemp !== null && st.outsideTemp <= LIMITS.frostC) {
    add({ key: "frost", level: "info", value: st.outsideTemp, unit: "\xB0C" });
  }
  if (st.updateTime !== null && ctx.now - st.updateTime > LIMITS.staleMs) {
    add({ key: "stale", level: "info", value: Math.floor((ctx.now - st.updateTime) / 36e5), unit: "h" });
  }
  if (ctx.loginExpires !== null && ctx.loginExpires - ctx.now < LIMITS.loginMs) {
    add({
      key: "login",
      level: "info",
      value: Math.max(0, Math.ceil((ctx.loginExpires - ctx.now) / 864e5)),
      unit: "d"
    });
  }
  return list.sort((a, b) => ORDER[a.level] - ORDER[b.level] || KEY_ORDER.indexOf(a.key) - KEY_ORDER.indexOf(b.key));
}
function worstLevel(list) {
  var _a, _b;
  return (_b = (_a = list[0]) == null ? void 0 : _a.level) != null ? _b : "none";
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  LIMITS,
  computeWarnings,
  worstLevel
});
//# sourceMappingURL=warnings.js.map
