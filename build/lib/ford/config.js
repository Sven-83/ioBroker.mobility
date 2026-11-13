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
  DEFAULT_REDIRECT_URI: () => DEFAULT_REDIRECT_URI,
  MAX_INTERVAL_MIN: () => MAX_INTERVAL_MIN,
  MIN_INTERVAL_MIN: () => MIN_INTERVAL_MIN,
  VEHICLE_SLOTS: () => VEHICLE_SLOTS,
  readFordConfig: () => readFordConfig
});
module.exports = __toCommonJS(config_exports);
const MIN_INTERVAL_MIN = 5;
const MAX_INTERVAL_MIN = 60;
const DEFAULT_INTERVAL_MIN = 30;
const DEFAULT_REDIRECT_URI = "http://localhost/fordconnect";
const VEHICLE_SLOTS = 2;
function clean(value) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
}
function readFordConfig(native) {
  const problems = [];
  const clientId = clean(native.fordClientId);
  const clientSecret = clean(native.fordClientSecret);
  let redirectUri = clean(native.fordRedirectUri) || DEFAULT_REDIRECT_URI;
  try {
    const url = new URL(redirectUri);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("protocol");
    }
  } catch {
    problems.push("redirect URI is not a valid http(s) address - using the default");
    redirectUri = DEFAULT_REDIRECT_URI;
  }
  let intervalMin = Number(native.fordInterval);
  if (!Number.isFinite(intervalMin) || intervalMin <= 0) {
    intervalMin = DEFAULT_INTERVAL_MIN;
  }
  intervalMin = Math.min(Math.max(Math.round(intervalMin), MIN_INTERVAL_MIN), MAX_INTERVAL_MIN);
  const vehicles = [];
  const names = [native.fordVehicle1Name, native.fordVehicle2Name];
  const tanks = [native.fordVehicle1Tank, native.fordVehicle2Tank];
  for (let i = 0; i < VEHICLE_SLOTS; i++) {
    const name = clean(names[i]).slice(0, 40);
    if (name) {
      const tank = Number(tanks[i]);
      const tankLitres = Number.isFinite(tank) && tank > 0 && tank <= 200 ? Math.round(tank) : 0;
      vehicles.push({ slot: i + 1, name, tankLitres });
    }
  }
  const wanted = native.fordEnabled === true;
  if (wanted && (!clientId || !clientSecret)) {
    problems.push("client ID or client secret missing - Ford stays off");
  }
  if (wanted && vehicles.length === 0) {
    problems.push("no vehicle name entered - Ford stays off");
  }
  return {
    config: {
      enabled: wanted && clientId !== "" && clientSecret !== "" && vehicles.length > 0,
      clientId,
      clientSecret,
      redirectUri,
      intervalMin,
      vehicles
    },
    problems
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_INTERVAL_MIN,
  DEFAULT_REDIRECT_URI,
  MAX_INTERVAL_MIN,
  MIN_INTERVAL_MIN,
  VEHICLE_SLOTS,
  readFordConfig
});
//# sourceMappingURL=config.js.map
