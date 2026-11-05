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
  WHEELS: () => WHEELS,
  parseTelemetry: () => parseTelemetry,
  sanitize: () => sanitize
});
module.exports = __toCommonJS(telemetry_exports);
const PRIVATE_KEY = /vin|position|latitude|longitude|location|gps|heading|address|plate|licen[cs]e|compass/i;
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
  const doors = list("doorStatus").map((door) => text(door.value));
  const doorsClosed = doors.length === 0 || doors.some((d) => d === null) ? null : doors.every((d) => (d == null ? void 0 : d.toUpperCase()) === "CLOSED");
  return {
    updateTime: time(body.updateTime),
    fuelLevel: num(value("fuelLevel")),
    fuelRange: num(value("fuelRange")),
    soc: num(value("xevBatteryStateOfCharge")),
    evRange: num(value("xevBatteryRange")),
    plugStatus: text(value("xevPlugChargerStatus")),
    chargeStatus: text(value("xevBatteryChargeDisplayStatus")),
    timeToFull: num(value("xevBatteryTimeToFullCharge")),
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  WHEELS,
  parseTelemetry,
  sanitize
});
//# sourceMappingURL=telemetry.js.map
