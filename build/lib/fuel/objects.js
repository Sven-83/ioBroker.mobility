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
  FUEL_ROOT: () => FUEL_ROOT,
  rootObjects: () => rootObjects,
  stationChannel: () => stationChannel,
  stationObjects: () => stationObjects
});
module.exports = __toCommonJS(objects_exports);
const FUEL_ROOT = "fuel";
function stationChannel(index) {
  return `${FUEL_ROOT}.station${index}`;
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
      id: FUEL_ROOT,
      obj: { type: "device", common: { name: n("Fuel prices", "Spritpreise") }, native: {} }
    },
    state(`${FUEL_ROOT}.cheapestStation`, n("Cheapest open station", "G\xFCnstigste offene Tankstelle"), {
      type: "string",
      role: "text"
    }),
    state(`${FUEL_ROOT}.cheapestPrice`, n("Cheapest price", "G\xFCnstigster Preis"), {
      type: "number",
      role: "value",
      unit: "\u20AC"
    }),
    state(`${FUEL_ROOT}.ranking`, n("Stations sorted by price (JSON)", "Tankstellen nach Preis (JSON)"), {
      type: "string",
      role: "json"
    })
  ];
}
function stationObjects(index, name) {
  const ch = stationChannel(index);
  const label = "E10";
  return [
    { id: ch, obj: { type: "channel", common: { name }, native: {} } },
    state(`${ch}.name`, n("Name", "Name"), { type: "string", role: "text" }),
    state(`${ch}.brand`, n("Brand", "Marke"), { type: "string", role: "text" }),
    state(`${ch}.address`, n("Address", "Adresse"), { type: "string", role: "text" }),
    state(`${ch}.status`, n("Status (open/closed/no prices)", "Status (open/closed/no prices)"), {
      type: "string",
      role: "text"
    }),
    state(`${ch}.open`, n("Open", "Ge\xF6ffnet"), { type: "boolean", role: "indicator" }),
    state(`${ch}.lastUpdate`, n("Last price update", "Letzte Preisabfrage"), {
      type: "number",
      role: "value.time"
    }),
    state(`${ch}.e10`, n("Price Super E10", "Preis Super E10"), { type: "number", role: "value", unit: "\u20AC" }),
    state(`${ch}.rating`, n(`${label} rating (7 days)`, `${label} Bewertung (7 Tage)`), {
      type: "string",
      role: "text",
      states: { cheap: "cheap", normal: "normal", expensive: "expensive", unknown: "unknown" }
    }),
    state(
      `${ch}.rank`,
      n(`${label}: share of time cheaper (7 days)`, `${label}: Anteil der Zeit g\xFCnstiger (7 Tage)`),
      {
        type: "number",
        role: "value",
        unit: "%",
        min: 0,
        max: 100
      }
    ),
    state(`${ch}.min7d`, n(`${label} minimum (7 days)`, `${label} Minimum (7 Tage)`), {
      type: "number",
      role: "value.min",
      unit: "\u20AC"
    }),
    state(`${ch}.max7d`, n(`${label} maximum (7 days)`, `${label} Maximum (7 Tage)`), {
      type: "number",
      role: "value.max",
      unit: "\u20AC"
    }),
    state(`${ch}.avg7d`, n(`${label} average (7 days)`, `${label} Durchschnitt (7 Tage)`), {
      type: "number",
      role: "value",
      unit: "\u20AC"
    }),
    state(`${ch}.coverage`, n("Recorded price history", "Aufgezeichnete Preishistorie"), {
      type: "number",
      role: "value",
      unit: "h"
    }),
    state(`${ch}.bestHour`, n("Usually cheapest hour (0-23)", "Meist g\xFCnstigste Stunde (0-23)"), {
      type: "number",
      role: "value",
      min: 0,
      max: 23
    }),
    state(`${ch}.bestHourPrice`, n("Average price in that hour", "Durchschnittspreis in dieser Stunde"), {
      type: "number",
      role: "value",
      unit: "\u20AC"
    }),
    state(`${ch}.bestWeekday`, n("Usually cheapest weekday", "Meist g\xFCnstigster Wochentag"), {
      type: "number",
      role: "value",
      min: 0,
      max: 6,
      states: {
        0: "Sunday",
        1: "Monday",
        2: "Tuesday",
        3: "Wednesday",
        4: "Thursday",
        5: "Friday",
        6: "Saturday"
      }
    }),
    state(`${ch}.bestWeekdayPrice`, n("Average price on that weekday", "Durchschnittspreis an diesem Wochentag"), {
      type: "number",
      role: "value",
      unit: "\u20AC"
    })
  ];
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  FUEL_ROOT,
  rootObjects,
  stationChannel,
  stationObjects
});
//# sourceMappingURL=objects.js.map
