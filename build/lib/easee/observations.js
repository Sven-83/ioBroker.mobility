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
var observations_exports = {};
__export(observations_exports, {
  OBS: () => OBS,
  OBSERVATION_IDS: () => OBSERVATION_IDS,
  OP_MODE: () => OP_MODE,
  OP_MODE_STATES: () => OP_MODE_STATES,
  REASON_TEXTS: () => REASON_TEXTS,
  isCarConnected: () => isCarConnected,
  parseChargerState: () => parseChargerState,
  reasonText: () => reasonText,
  toBoolean: () => toBoolean,
  toNumber: () => toNumber
});
module.exports = __toCommonJS(observations_exports);
const OBS = {
  isEnabled: 31,
  phaseMode: 38,
  authorizationRequired: 42,
  maxChargerCurrent: 47,
  dynamicChargerCurrent: 48,
  reasonForNoCurrent: 96,
  smartCharging: 102,
  cableLocked: 103,
  opMode: 109,
  outputCurrent: 114,
  errorCode: 119,
  totalPower: 120,
  sessionEnergy: 121,
  lifetimeEnergy: 124,
  connectedToCloud: 250
};
const OBSERVATION_IDS = Object.values(OBS);
const OP_MODE = {
  offline: 0,
  disconnected: 1,
  awaitingStart: 2,
  charging: 3,
  completed: 4,
  error: 5,
  readyToCharge: 6,
  awaitingAuthentication: 7,
  deauthenticating: 8
};
const OP_MODE_STATES = {
  0: "Offline",
  1: "Disconnected",
  2: "Awaiting start",
  3: "Charging",
  4: "Completed",
  5: "Error",
  6: "Ready to charge",
  7: "Awaiting authentication",
  8: "Deauthenticating"
};
const REASON_TEXTS = {
  0: "OK",
  1: "Max circuit limit too low",
  2: "Max dynamic circuit limit too low",
  3: "Max dynamic offline limit too low",
  4: "Circuit fuse too low",
  5: "Waiting in queue",
  6: "Waiting in fully",
  7: "Illegal grid type",
  8: "No current request received",
  9: "Not connected to master",
  10: "Equalizer current too low",
  11: "Phase not connected",
  25: "Limited by circuit fuse",
  26: "Limited by circuit max limit",
  27: "Limited by circuit dynamic limit",
  28: "Limited by equalizer",
  29: "Limited by load balancing",
  30: "Limited by offline settings",
  50: "No car connected or no current request",
  51: "Max charger limit too low",
  52: "Max dynamic charger limit too low",
  53: "Charger disabled",
  54: "Waiting for schedule/authorization",
  55: "Pending authorization",
  56: "Charger in error state",
  57: "EV erratic",
  75: "Limited by cable rating",
  76: "Limited by schedule",
  77: "Limited by charger max limit",
  78: "Limited by charger dynamic limit",
  79: "EV is not charging",
  80: "Limited by local adjustment",
  81: "Limited by EV",
  100: "Undefined"
};
function reasonText(code) {
  var _a;
  if (code === null) {
    return "";
  }
  return (_a = REASON_TEXTS[code]) != null ? _a : `Code ${code}`;
}
function toNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}
function toBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (text === "true" || text === "1") {
      return true;
    }
    if (text === "false" || text === "0") {
      return false;
    }
  }
  return null;
}
function rounded(value, digits) {
  const number = toNumber(value);
  if (number === null) {
    return null;
  }
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}
function integer(value) {
  const number = toNumber(value);
  return number === null ? null : Math.round(number);
}
function parseChargerState(observations) {
  const byId = /* @__PURE__ */ new Map();
  let latestPulse = null;
  for (const observation of observations) {
    byId.set(observation.id, observation);
    const time = Date.parse(observation.timestamp);
    if (Number.isFinite(time) && (latestPulse === null || time > latestPulse)) {
      latestPulse = time;
    }
  }
  const value = (id) => {
    var _a;
    return (_a = byId.get(id)) == null ? void 0 : _a.value;
  };
  const opMode = integer(value(OBS.opMode));
  return {
    online: toBoolean(value(OBS.connectedToCloud)),
    opMode: opMode !== null && opMode >= 0 && opMode <= 8 ? opMode : null,
    enabled: toBoolean(value(OBS.isEnabled)),
    phaseMode: integer(value(OBS.phaseMode)),
    authorizationRequired: toBoolean(value(OBS.authorizationRequired)),
    maxCurrent: rounded(value(OBS.maxChargerCurrent), 1),
    dynamicCurrent: rounded(value(OBS.dynamicChargerCurrent), 1),
    reasonForNoCurrent: integer(value(OBS.reasonForNoCurrent)),
    smartCharging: toBoolean(value(OBS.smartCharging)),
    cableLocked: toBoolean(value(OBS.cableLocked)),
    outputCurrent: rounded(value(OBS.outputCurrent), 1),
    errorCode: integer(value(OBS.errorCode)),
    power: rounded(value(OBS.totalPower), 3),
    sessionEnergy: rounded(value(OBS.sessionEnergy), 3),
    lifetimeEnergy: rounded(value(OBS.lifetimeEnergy), 3),
    latestPulse
  };
}
function isCarConnected(opMode) {
  if (opMode === null) {
    return null;
  }
  return opMode === OP_MODE.awaitingStart || opMode === OP_MODE.charging || opMode === OP_MODE.completed || opMode === OP_MODE.readyToCharge || opMode === OP_MODE.awaitingAuthentication;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  OBS,
  OBSERVATION_IDS,
  OP_MODE,
  OP_MODE_STATES,
  REASON_TEXTS,
  isCarConnected,
  parseChargerState,
  reasonText,
  toBoolean,
  toNumber
});
//# sourceMappingURL=observations.js.map
