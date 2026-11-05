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
  DEFAULT_INTERVAL_MIN: () => DEFAULT_INTERVAL_MIN,
  MAX_INTERVAL_MIN: () => MAX_INTERVAL_MIN,
  MIN_INTERVAL_MIN: () => MIN_INTERVAL_MIN,
  STATION_SLOTS: () => STATION_SLOTS,
  readFuelConfig: () => readFuelConfig
});
module.exports = __toCommonJS(config_exports);
var import_tankerkoenig = require("./tankerkoenig");
const STATION_SLOTS = 2;
const MIN_INTERVAL_MIN = 5;
const MAX_INTERVAL_MIN = 60;
const DEFAULT_INTERVAL_MIN = 10;
const SLOT_FIELDS = [
  { slot: 1, id: "fuelStation1Id", name: "fuelStation1Name" },
  { slot: 2, id: "fuelStation2Id", name: "fuelStation2Name" }
];
function readFuelConfig(native) {
  const problems = [];
  const apiKey = (0, import_tankerkoenig.normalizeApiKey)(native.fuelApiKey);
  if (apiKey && !import_tankerkoenig.API_KEY_PATTERN.test(apiKey)) {
    problems.push("Tankerkoenig API key has an invalid format (expected 00000000-0000-0000-0000-000000000000)");
  }
  const stations = [];
  for (const fields of SLOT_FIELDS) {
    const rawId = native[fields.id];
    const rawName = native[fields.name];
    const id = typeof rawId === "string" ? rawId.trim().toLowerCase() : "";
    const name = typeof rawName === "string" ? rawName.trim().slice(0, 60) : "";
    if (!id) {
      continue;
    }
    if (!import_tankerkoenig.STATION_ID_PATTERN.test(id)) {
      problems.push(`Station ${fields.slot}: invalid station ID (expected UUID), skipped`);
      continue;
    }
    if (stations.some((station) => station.id === id)) {
      problems.push(`Station ${fields.slot}: same ID as station 1, skipped`);
      continue;
    }
    stations.push({ id, name: name || `Station ${fields.slot}`, slot: fields.slot });
  }
  let intervalMin = Number(native.fuelInterval);
  if (!Number.isFinite(intervalMin)) {
    intervalMin = DEFAULT_INTERVAL_MIN;
  }
  if (intervalMin < MIN_INTERVAL_MIN || intervalMin > MAX_INTERVAL_MIN) {
    problems.push(
      `Poll interval ${intervalMin} min outside ${MIN_INTERVAL_MIN}-${MAX_INTERVAL_MIN} min, using the nearest limit`
    );
    intervalMin = Math.min(Math.max(intervalMin, MIN_INTERVAL_MIN), MAX_INTERVAL_MIN);
  }
  intervalMin = Math.round(intervalMin);
  const enabled = native.fuelEnabled !== false && import_tankerkoenig.API_KEY_PATTERN.test(apiKey) && stations.length > 0;
  return { config: { enabled, apiKey, stations, intervalMin }, problems };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_INTERVAL_MIN,
  MAX_INTERVAL_MIN,
  MIN_INTERVAL_MIN,
  STATION_SLOTS,
  readFuelConfig
});
//# sourceMappingURL=config.js.map
