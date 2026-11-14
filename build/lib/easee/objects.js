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
  EASEE_ROOT: () => EASEE_ROOT,
  chargerChannel: () => chargerChannel,
  chargerObjects: () => chargerObjects,
  historyObjects: () => historyObjects,
  parseChargerCommandId: () => parseChargerCommandId,
  rootObjects: () => rootObjects
});
module.exports = __toCommonJS(objects_exports);
var import_observations = require("./observations");
const EASEE_ROOT = "easee";
function chargerChannel(slot) {
  return `${EASEE_ROOT}.charger${slot}`;
}
function parseChargerCommandId(namespace, id) {
  const prefix = `${namespace}.${EASEE_ROOT}.charger`;
  if (!id.startsWith(prefix)) {
    return void 0;
  }
  const [slotText, command, ...rest] = id.slice(prefix.length).split(".");
  const slot = Number(slotText);
  if (rest.length > 0 || !/^\d+$/.test(slotText) || command !== "charge" && command !== "refresh") {
    return void 0;
  }
  return { slot, command };
}
function n(en, de) {
  return { en, de };
}
function state(id, name, common) {
  return {
    id,
    obj: { type: "state", common: { name, read: true, write: false, ...common }, native: {} }
  };
}
function rootObjects() {
  return [
    {
      id: EASEE_ROOT,
      obj: { type: "device", common: { name: n("Easee chargers", "Easee-Wallboxen") }, native: {} }
    },
    state(`${EASEE_ROOT}.streamConnected`, n("Real-time stream connected", "Echtzeit-Stream verbunden"), {
      type: "boolean",
      role: "indicator.connected"
    })
  ];
}
function chargerObjects(slot, name, withCost) {
  const ch = chargerChannel(slot);
  const amps = { type: "number", role: "value.current", unit: "A" };
  const list = [
    { id: ch, obj: { type: "channel", common: { name: name || `Charger ${slot}` }, native: {} } },
    state(`${ch}.name`, n("Name", "Name"), { type: "string", role: "info.name" }),
    state(`${ch}.online`, n("Connected to the Easee cloud", "Mit der Easee-Cloud verbunden"), {
      type: "boolean",
      role: "indicator.reachable"
    }),
    state(`${ch}.opMode`, n("Operating mode", "Betriebszustand"), {
      type: "number",
      role: "value",
      states: import_observations.OP_MODE_STATES
    }),
    state(`${ch}.status`, n("Operating mode (text)", "Betriebszustand (Text)"), { type: "string", role: "text" }),
    state(`${ch}.carConnected`, n("Car plugged in", "Auto eingesteckt"), { type: "boolean", role: "indicator" }),
    state(`${ch}.charging`, n("Charging", "L\xE4dt"), { type: "boolean", role: "indicator.working" }),
    state(`${ch}.power`, n("Charging power", "Ladeleistung"), {
      type: "number",
      role: "value.power",
      unit: "kW"
    }),
    state(`${ch}.sessionEnergy`, n("Energy of the current/last session", "Energie der aktuellen/letzten Ladung"), {
      type: "number",
      role: "value.energy",
      unit: "kWh"
    }),
    state(`${ch}.lifetimeEnergy`, n("Total energy (meter)", "Gesamtenergie (Z\xE4hler)"), {
      type: "number",
      role: "value.energy.consumed",
      unit: "kWh"
    }),
    state(`${ch}.dynamicCurrent`, n("Dynamic charger current", "Dynamischer Ladestrom"), amps),
    state(`${ch}.maxCurrent`, n("Max charger current", "Maximaler Ladestrom"), amps),
    state(`${ch}.outputCurrent`, n("Current offered to the car", "Dem Auto angebotener Strom"), amps),
    state(`${ch}.phaseMode`, n("Phase mode", "Phasenmodus"), {
      type: "number",
      role: "value",
      states: { 1: "1-phase", 2: "Auto", 3: "3-phase" }
    }),
    state(`${ch}.cableLocked`, n("Cable locked", "Kabel verriegelt"), {
      type: "boolean",
      role: "indicator.lock"
    }),
    state(`${ch}.smartCharging`, n("Smart charging", "Smart Charging"), { type: "boolean", role: "indicator" }),
    state(`${ch}.authorizationRequired`, n("Authorization required", "Autorisierung n\xF6tig"), {
      type: "boolean",
      role: "indicator"
    }),
    state(`${ch}.enabled`, n("Charger enabled", "Wallbox aktiviert"), { type: "boolean", role: "indicator" }),
    state(`${ch}.reasonForNoCurrent`, n("Reason for no current (code)", "Grund f\xFCr keinen Strom (Code)"), {
      type: "number",
      role: "value"
    }),
    state(`${ch}.reasonText`, n("Reason for no current", "Grund f\xFCr keinen Strom"), {
      type: "string",
      role: "text"
    }),
    state(`${ch}.errorCode`, n("Error code (0 = none)", "Fehlercode (0 = keiner)"), {
      type: "number",
      role: "value"
    }),
    state(`${ch}.lastUpdate`, n("Last value from the charger", "Letzter Wert der Wallbox"), {
      type: "number",
      role: "value.time"
    }),
    state(`${ch}.charge`, n("Charge (true = start, false = stop)", "Laden (true = Start, false = Stopp)"), {
      type: "boolean",
      role: "switch",
      write: true
    }),
    state(`${ch}.refresh`, n("Read values now", "Werte jetzt lesen"), {
      type: "boolean",
      role: "button",
      read: false,
      write: true
    })
  ];
  if (withCost) {
    list.push(
      state(`${ch}.sessionCost`, n("Cost of the current/last session", "Kosten der aktuellen/letzten Ladung"), {
        type: "number",
        role: "value",
        unit: "\u20AC"
      })
    );
  }
  return list;
}
function historyObjects(prefix, withCost) {
  const p = `${prefix}.history`;
  const json = { type: "string", role: "json" };
  const kwh = { type: "number", role: "value.energy", unit: "kWh" };
  const eur = { type: "number", role: "value", unit: "\u20AC" };
  const list = [
    {
      id: p,
      obj: { type: "channel", common: { name: n("Charging sessions", "Ladevorg\xE4nge") }, native: {} }
    },
    state(`${p}.days`, n("Last 14 days (JSON)", "Letzte 14 Tage (JSON)"), json),
    state(`${p}.weeks`, n("Last 12 weeks (JSON)", "Letzte 12 Wochen (JSON)"), json),
    state(`${p}.months`, n("Last 13 months (JSON)", "Letzte 13 Monate (JSON)"), json),
    state(`${p}.monthEnergy`, n("Charged this month", "Geladen diesen Monat"), kwh),
    state(`${p}.yearEnergy`, n("Charged this year", "Geladen dieses Jahr"), kwh),
    state(`${p}.lastSession`, n("Last session (JSON)", "Letzte Ladung (JSON)"), json),
    state(`${p}.oldestSession`, n("First known session", "Erste bekannte Ladung"), {
      type: "number",
      role: "value.time"
    }),
    state(`${p}.sessionCount`, n("Known sessions", "Bekannte Ladevorg\xE4nge"), { type: "number", role: "value" })
  ];
  if (prefix !== EASEE_ROOT) {
    list.push(
      state(`${p}.lastSync`, n("Sessions read from Easee", "Ladevorg\xE4nge von Easee gelesen"), {
        type: "number",
        role: "value.time"
      })
    );
  }
  if (withCost) {
    list.push(
      state(`${p}.monthCost`, n("Charging cost this month", "Ladekosten diesen Monat"), eur),
      state(`${p}.yearCost`, n("Charging cost this year", "Ladekosten dieses Jahr"), eur)
    );
  }
  return list;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  EASEE_ROOT,
  chargerChannel,
  chargerObjects,
  historyObjects,
  parseChargerCommandId,
  rootObjects
});
//# sourceMappingURL=objects.js.map
