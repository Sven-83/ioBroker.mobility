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
var objects_exports = {};
__export(objects_exports, {
  FORD_ROOT: () => FORD_ROOT,
  parseVehicleCommandId: () => parseVehicleCommandId,
  rootObjects: () => rootObjects,
  vehicleChannel: () => vehicleChannel,
  vehicleObjects: () => vehicleObjects
});
module.exports = __toCommonJS(objects_exports);
var import_telemetry = require("./telemetry");
const FORD_ROOT = "ford";
function vehicleChannel(slot) {
  return `${FORD_ROOT}.vehicle${slot}`;
}
function parseVehicleCommandId(namespace, id) {
  const prefix = `${namespace}.${FORD_ROOT}.vehicle`;
  if (!id.startsWith(prefix)) {
    return void 0;
  }
  const rest = id.slice(prefix.length);
  const match = /^(\d+)\.(login\.response|refresh)$/.exec(rest);
  if (!match) {
    return void 0;
  }
  return { slot: Number(match[1]), command: match[2] === "refresh" ? "refresh" : "login" };
}
function n(en, de) {
  return { en, de };
}
function state(id, name, common) {
  return { id, obj: { type: "state", common: { name, read: true, write: false, ...common }, native: {} } };
}
function rootObjects() {
  return [
    { id: FORD_ROOT, obj: { type: "device", common: { name: n("Ford vehicles", "Ford-Fahrzeuge") }, native: {} } }
  ];
}
function vehicleObjects(slot, name) {
  const ch = vehicleChannel(slot);
  const percent = { type: "number", role: "value", unit: "%" };
  const km = { type: "number", role: "value.distance", unit: "km" };
  const list = [
    { id: ch, obj: { type: "channel", common: { name }, native: {} } },
    state(`${ch}.name`, n("Name", "Name"), { type: "string", role: "info.name" }),
    state(`${ch}.model`, n("Model", "Modell"), { type: "string", role: "info.model" }),
    state(`${ch}.engineType`, n("Engine type (ICE, BEV, ...)", "Antrieb (ICE, BEV, ...)"), {
      type: "string",
      role: "text"
    }),
    {
      id: `${ch}.login`,
      obj: { type: "folder", common: { name: n("Ford login", "Ford-Anmeldung") }, native: {} }
    },
    state(`${ch}.login.url`, n("Login address (open in the browser)", "Login-Adresse (im Browser \xF6ffnen)"), {
      type: "string",
      role: "url"
    }),
    state(
      `${ch}.login.response`,
      n("Paste the address after the login here", "Adresse nach dem Login hier einf\xFCgen"),
      { type: "string", role: "text", write: true, def: "" }
    ),
    state(`${ch}.login.status`, n("Login status", "Anmeldestatus"), { type: "string", role: "text" }),
    state(`${ch}.login.expires`, n("Login expires", "Anmeldung l\xE4uft ab"), { type: "number", role: "value.time" }),
    state(`${ch}.login.token`, n("Token (encrypted, internal)", "Token (verschl\xFCsselt, intern)"), {
      type: "string",
      role: "text",
      read: false
    }),
    state(`${ch}.lastUpdate`, n("Time of the vehicle data", "Zeitpunkt der Fahrzeugdaten"), {
      type: "number",
      role: "value.time"
    }),
    state(`${ch}.fuelLevel`, n("Fuel level", "Tankf\xFCllung"), { ...percent, role: "value.fill" }),
    state(`${ch}.fuelRange`, n("Fuel range", "Reichweite (Kraftstoff)"), km),
    state(`${ch}.soc`, n("Battery (high voltage)", "Akku (Hochvolt)"), { ...percent, role: "value.battery" }),
    state(`${ch}.evRange`, n("Electric range", "Reichweite (elektrisch)"), km),
    state(`${ch}.plugStatus`, n("Charging plug", "Ladestecker"), { type: "string", role: "text" }),
    state(`${ch}.chargeStatus`, n("Charging status", "Ladestatus"), { type: "string", role: "text" }),
    state(`${ch}.timeToFull`, n("Time until full", "Zeit bis voll"), {
      type: "number",
      role: "value.interval",
      unit: "min"
    }),
    state(`${ch}.odometer`, n("Odometer", "Kilometerstand"), km),
    state(`${ch}.battery12v`, n("12 V battery", "12-V-Batterie"), percent),
    state(`${ch}.battery12vVoltage`, n("12 V battery voltage", "12-V-Batteriespannung"), {
      type: "number",
      role: "value.voltage",
      unit: "V"
    }),
    state(`${ch}.oilLife`, n("Oil life", "\xD6l-Restlebensdauer"), percent),
    state(`${ch}.outsideTemp`, n("Outside temperature", "Au\xDFentemperatur"), {
      type: "number",
      role: "value.temperature",
      unit: "\xB0C"
    }),
    state(`${ch}.coolantTemp`, n("Coolant temperature", "K\xFChlmitteltemperatur"), {
      type: "number",
      role: "value.temperature",
      unit: "\xB0C"
    }),
    state(`${ch}.ignition`, n("Ignition", "Z\xFCndung"), { type: "string", role: "text" }),
    state(`${ch}.alarm`, n("Alarm", "Alarmanlage"), { type: "string", role: "text" }),
    state(`${ch}.doorsClosed`, n("All doors closed", "Alle T\xFCren zu"), { type: "boolean", role: "indicator" }),
    { id: `${ch}.tires`, obj: { type: "folder", common: { name: n("Tyre pressure", "Reifendruck") }, native: {} } },
    state(`${ch}.metricKeys`, n("Metrics the vehicle delivers", "Vom Fahrzeug gelieferte Werte"), {
      type: "string",
      role: "json"
    }),
    state(`${ch}.raw`, n("Telemetry without VIN/position (JSON)", "Telemetrie ohne FIN/Standort (JSON)"), {
      type: "string",
      role: "json"
    }),
    state(`${ch}.refresh`, n("Read values now", "Werte jetzt lesen"), {
      type: "boolean",
      role: "button",
      read: false,
      write: true
    })
  ];
  for (const wheel of Object.values(import_telemetry.WHEELS)) {
    list.push(
      state(`${ch}.tires.${wheel}`, n(`Tyre ${wheel}`, `Reifen ${wheel}`), {
        type: "number",
        role: "value.pressure",
        unit: "kPa"
      })
    );
  }
  return list;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  FORD_ROOT,
  parseVehicleCommandId,
  rootObjects,
  vehicleChannel,
  vehicleObjects
});
//# sourceMappingURL=objects.js.map
