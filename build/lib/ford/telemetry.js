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
var telemetry_exports = {};
__export(telemetry_exports, {
  BATTERY_12V_LOW_PERCENT: () => BATTERY_12V_LOW_PERCENT,
  BATTERY_12V_LOW_VOLT: () => BATTERY_12V_LOW_VOLT,
  WHEELS: () => WHEELS,
  battery12vLow: () => battery12vLow,
  isBev: () => isBev,
  parseTelemetry: () => parseTelemetry,
  sanitize: () => sanitize
});
module.exports = __toCommonJS(telemetry_exports);
const PRIVATE_KEY = /vin|position|latitude|longitude|location|gps|heading|address|plate|licen[cs]e|compass|^vehicle_?id$/i;
const BATTERY_12V_LOW_PERCENT = 40;
const BATTERY_12V_LOW_VOLT = 12.2;
const WHEELS = {
  FRONT_LEFT: "frontLeft",
  FRONT_RIGHT: "frontRight",
  REAR_LEFT: "rearLeft",
  REAR_RIGHT: "rearRight"
};
function num(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value * 100) / 100;
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Math.round(Number(value) * 100) / 100;
  }
  return null;
}
function text(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 60) : null;
}
function time(value) {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}
function parseTelemetry(body) {
  var _a, _b, _c, _d, _e, _f, _g;
  const metrics = typeof body.metrics === "object" && body.metrics !== null && !Array.isArray(body.metrics) ? body.metrics : {};
  const value = (key) => {
    const entry = metrics[key];
    return typeof entry === "object" && entry !== null && !Array.isArray(entry) ? entry.value : void 0;
  };
  const list = (key) => Array.isArray(metrics[key]) ? metrics[key].filter(
    (e) => typeof e === "object" && e !== null
  ) : [];
  const tires = {};
  for (const tire of list("tirePressure")) {
    const wheel = WHEELS[typeof tire.vehicleWheel === "string" ? tire.vehicleWheel.toUpperCase() : ""];
    const pressure = num(tire.value);
    if (wheel && pressure !== null) {
      tires[wheel] = pressure;
    }
  }
  const tireStatus = {};
  for (const entry of list("tirePressureStatus")) {
    const wheel = WHEELS[typeof entry.vehicleWheel === "string" ? entry.vehicleWheel.toUpperCase() : ""];
    const status = text(entry.value);
    if (wheel && status) {
      tireStatus[wheel] = status.toUpperCase();
    }
  }
  const tirePlacard = {};
  for (const tire of list("tirePressure")) {
    const wheel = WHEELS[typeof tire.vehicleWheel === "string" ? tire.vehicleWheel.toUpperCase() : ""];
    const placard = num((_a = tire.wheelPlacardFront) != null ? _a : tire.wheelPlacardRear);
    if (wheel && placard !== null && placard > 0) {
      tirePlacard[wheel] = placard;
    }
  }
  const hood = (_b = text(value("hoodStatus"))) == null ? void 0 : _b.toUpperCase();
  const alarmText = (_c = text(value("alarmStatus"))) == null ? void 0 : _c.toUpperCase();
  const panicText = (_d = text(value("panicAlarmStatus"))) == null ? void 0 : _d.toUpperCase();
  const alarmTriggered = alarmText === void 0 && panicText === void 0 ? null : /TRIGGER|ALARMING|SOUNDING/.test(alarmText != null ? alarmText : "") || /^(ACTIVE|ON|TRIGGERED)$/.test(panicText != null ? panicText : "");
  const doors = list("doorStatus").map((door) => text(door.value));
  const doorsClosed = doors.length === 0 || doors.some((d) => d === null) ? null : doors.every((d) => (d == null ? void 0 : d.toUpperCase()) === "CLOSED");
  const allDoors = list("doorLockStatus").find((e) => {
    var _a2;
    return ((_a2 = text(e.vehicleDoor)) == null ? void 0 : _a2.toUpperCase()) === "ALL_DOORS";
  });
  const lock = allDoors ? (_e = text(allDoors.value)) == null ? void 0 : _e.toUpperCase() : void 0;
  const locked = lock === void 0 || lock === null ? null : lock.includes("LOCKED") && !lock.includes("UNLOCKED");
  const lockTime = allDoors ? time(allDoors.updateTime) : null;
  const windows = list("windowStatus").map((w) => {
    var _a2;
    const range = (_a2 = w.value) == null ? void 0 : _a2.doubleRange;
    return num(range == null ? void 0 : range.upperBound);
  });
  const windowsClosed = windows.length === 0 || windows.some((w) => w === null) ? null : windows.every((w) => w === 0);
  const chargerVolt = num(value("xevBatteryChargerVoltageOutput"));
  const chargerAmp = num(value("xevBatteryChargerCurrentOutput"));
  const chargePower = chargerVolt === null || chargerAmp === null ? null : Math.max(0, Math.round(chargerVolt * chargerAmp / 10) / 100);
  return {
    updateTime: time(body.updateTime),
    fuelLevel: num(value("fuelLevel")),
    fuelRange: num(value("fuelRange")),
    soc: num(value("xevBatteryStateOfCharge")),
    evRange: num(value("xevBatteryRange")),
    plugStatus: text(value("xevPlugChargerStatus")),
    chargeStatus: text(value("xevBatteryChargeDisplayStatus")),
    timeToFull: num(value("xevBatteryTimeToFullCharge")),
    energyRemaining: num(value("xevBatteryEnergyRemaining")),
    batteryCapacity: num(value("xevBatteryCapacity")),
    evMaxRange: num(value("xevBatteryMaximumRange")),
    batteryTemp: num(value("xevBatteryTemperature")),
    chargePower,
    odometer: num(value("odometer")),
    battery12v: num(value("batteryStateOfCharge")),
    battery12vVoltage: num(value("batteryVoltage")),
    oilLife: num(value("oilLifeRemaining")),
    outsideTemp: num(value("outsideTemperature")),
    coolantTemp: num(value("engineCoolantTemp")),
    ignition: text(value("ignitionStatus")),
    alarm: text(value("alarmStatus")),
    tires,
    doorsClosed,
    locked,
    lockTime,
    hoodClosed: hood === void 0 ? null : hood === "CLOSED",
    tireStatus,
    tirePlacard,
    alarmTriggered,
    batteryPerformance: (_g = (_f = text(value("xevBatteryPerformanceStatus"))) == null ? void 0 : _f.toUpperCase()) != null ? _g : null,
    windowsClosed,
    metricKeys: Object.keys(metrics).sort()
  };
}
function sanitize(value) {
  if (Array.isArray(value)) {
    return value.map(sanitize);
  }
  if (typeof value === "object" && value !== null) {
    const result = {};
    for (const [key, inner] of Object.entries(value)) {
      if (!PRIVATE_KEY.test(key)) {
        result[key] = sanitize(inner);
      }
    }
    return result;
  }
  if (typeof value === "string" && /\b[A-HJ-NPR-Z0-9]{17}\b/.test(value)) {
    return value.replace(/\b[A-HJ-NPR-Z0-9]{17}\b/g, "<vin>");
  }
  return value;
}
function isBev(st) {
  return st.soc !== null && st.fuelLevel === null;
}
function battery12vLow(st) {
  var _a;
  if (st.battery12v !== null) {
    return st.battery12v < BATTERY_12V_LOW_PERCENT;
  }
  if (st.battery12vVoltage !== null && ((_a = st.ignition) == null ? void 0 : _a.toUpperCase()) === "OFF") {
    return st.battery12vVoltage < BATTERY_12V_LOW_VOLT;
  }
  return null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BATTERY_12V_LOW_PERCENT,
  BATTERY_12V_LOW_VOLT,
  WHEELS,
  battery12vLow,
  isBev,
  parseTelemetry,
  sanitize
});
//# sourceMappingURL=telemetry.js.map
