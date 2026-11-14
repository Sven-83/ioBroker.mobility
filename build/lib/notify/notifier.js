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
var notifier_exports = {};
__export(notifier_exports, {
  FUEL_LEVEL: () => FUEL_LEVEL,
  FUEL_REARM_LEVEL: () => FUEL_REARM_LEVEL,
  NOTIFY_STATE: () => NOTIFY_STATE,
  Notifier: () => Notifier,
  fmt: () => fmt,
  notifyInstance: () => notifyInstance,
  notifyUsers: () => notifyUsers
});
module.exports = __toCommonJS(notifier_exports);
const NOTIFY_STATE = "info.notifications";
const FUEL_LEVEL = 25;
const FUEL_REARM_LEVEL = 30;
const DAY_MS = 24 * 36e5;
const TYRE_REPEAT_MS = 7 * DAY_MS;
const OP_CHARGING = 3;
const OP_COMPLETED = 4;
const OP_ERROR = 5;
const WHEEL_DE = {
  frontLeft: "vorne links",
  frontRight: "vorne rechts",
  rearLeft: "hinten links",
  rearRight: "hinten rechts"
};
const WHEEL_EN = {
  frontLeft: "front left",
  frontRight: "front right",
  rearLeft: "rear left",
  rearRight: "rear right"
};
function num(value) {
  if (value === null || value === void 0 || value === "" || typeof value === "boolean") {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
function parseList(value) {
  try {
    const list = typeof value === "string" && value ? JSON.parse(value) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
function fmt(n, decimals, german) {
  return n.toLocaleString(german ? "de-DE" : "en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}
function day(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
class Notifier {
  /**
   * @param host - Adapter functions
   * @param options - Instance settings
   */
  constructor(host, options) {
    this.host = host;
    this.options = options;
  }
  values = /* @__PURE__ */ new Map();
  sent = {};
  loaded = false;
  /** sends one after the other, in the order of the events */
  queue = Promise.resolve();
  /** Reads what was sent before the restart */
  async start() {
    try {
      const raw = await this.host.read();
      const data = typeof raw === "string" && raw ? JSON.parse(raw) : {};
      if (data && typeof data === "object" && !Array.isArray(data)) {
        for (const [key, entry] of Object.entries(data)) {
          const e = entry;
          if (e && typeof e.at === "number" && typeof e.active === "boolean") {
            this.sent[key] = { at: e.at, active: e.active };
          }
        }
      }
    } catch {
      this.sent = {};
    }
    this.loaded = true;
  }
  /** Waits until all queued messages are sent (tests, unload) */
  flush() {
    return this.queue;
  }
  /**
   * A value the adapter has just written.
   *
   * @param id - Relative state ID, e.g. easee.charger1.opMode
   * @param value - New value
   */
  observe(id, value) {
    const before = this.values.get(id);
    this.values.set(id, value);
    if (!this.loaded) {
      return;
    }
    let m = /^easee\.charger(\d+)\.opMode$/.exec(id);
    if (m) {
      this.chargerChanged(Number(m[1]), num(before), num(value));
      return;
    }
    m = /^ford\.vehicle(\d+)\.warnings$/.exec(id);
    if (m) {
      this.warningsChanged(Number(m[1]), value);
      this.checkFuel();
      return;
    }
    if (/^ford\.vehicle\d+\.fuelLevel$/.test(id) || id === "fuel.ranking") {
      this.checkFuel();
    }
  }
  // ---------------------------------------------------------------- rules
  chargerChanged(slot, before, now) {
    if (now === OP_CHARGING) {
      this.once(`abort.charger${slot}`, false);
      return;
    }
    if (before !== OP_CHARGING) {
      return;
    }
    const g = this.options.german;
    const name = text(this.values.get(`easee.charger${slot}.name`)) || `Wallbox ${slot}`;
    const car = this.pluggedCar();
    if (now === OP_COMPLETED && this.on("full")) {
      const kwh = num(this.values.get(`easee.charger${slot}.sessionEnergy`));
      const cost = num(this.values.get(`easee.charger${slot}.sessionCost`));
      const soc = car ? num(this.values.get(`ford.vehicle${car.slot}.soc`)) : null;
      const parts = [
        kwh !== null ? `${fmt(kwh, 1, g)} kWh` : "",
        cost !== null ? `${fmt(cost, 2, g)} \u20AC` : "",
        soc !== null ? g ? `Akku ${fmt(soc, 0, g)} %` : `battery ${fmt(soc, 0, g)} %` : ""
      ].filter(Boolean);
      const who = car ? `${car.name} ` : "";
      this.send(
        g ? `\u{1F50B} ${who}fertig geladen an ${name}${parts.length ? ` \xB7 ${parts.join(" \xB7 ")}` : ""}` : `\u{1F50B} ${who}charging finished at ${name}${parts.length ? ` \xB7 ${parts.join(" \xB7 ")}` : ""}`
      );
      return;
    }
    if (now === OP_ERROR && this.on("charge")) {
      const reason = text(this.values.get(`easee.charger${slot}.reasonText`));
      this.once(
        `abort.charger${slot}`,
        true,
        () => g ? `\u26A0\uFE0F Laden abgebrochen an ${name}: Wallbox meldet einen Fehler${reason ? ` (${reason})` : ""}` : `\u26A0\uFE0F Charging stopped at ${name}: the charger reports an error${reason ? ` (${reason})` : ""}`
      );
      return;
    }
    this.once(`abort.charger${slot}`, false);
  }
  warningsChanged(slot, value) {
    var _a;
    const g = this.options.german;
    const name = text(this.values.get(`ford.vehicle${slot}.name`)) || `${g ? "Fahrzeug" : "Vehicle"} ${slot}`;
    const list = parseList(value).filter((w) => !!w && typeof w === "object" && "key" in w);
    const has = (key) => list.find((w) => w.key === key);
    if (this.on("charge")) {
      this.once(
        `abort.vehicle${slot}`,
        !!has("chargeFault"),
        () => g ? `\u26A0\uFE0F ${name}: Laden abgebrochen (meldet das Auto)` : `\u26A0\uFE0F ${name}: charging stopped (reported by the car)`
      );
    }
    const plugKey = `plug.vehicle${slot}.${day(this.host.now())}`;
    if (this.on("plug") && !this.sent[plugKey]) {
      const w = has("notPluggedIn");
      const soc = (_a = w == null ? void 0 : w.value) != null ? _a : num(this.values.get(`ford.vehicle${slot}.soc`));
      this.once(
        plugKey,
        !!w,
        () => g ? `\u{1F50C} ${name} ist nicht eingesteckt${soc !== null && soc !== void 0 ? ` \xB7 Akku ${fmt(soc, 0, g)} %` : ""}` : `\u{1F50C} ${name} is not plugged in${soc !== null && soc !== void 0 ? ` \xB7 battery ${fmt(soc, 0, g)} %` : ""}`,
        true
      );
    }
    if (this.on("tyres")) {
      for (const wheel of Object.keys(WHEEL_DE)) {
        const w = list.find((x) => x.key === "tyreLoss" && x.wheel === wheel);
        const key = `tyre.vehicle${slot}.${wheel}`;
        const last = this.sent[key];
        if (w && last && !last.active && this.host.now() - last.at < TYRE_REPEAT_MS) {
          continue;
        }
        this.once(key, !!w, () => {
          const loss = (w == null ? void 0 : w.value) !== void 0 ? fmt(w.value, 2, g) : "";
          return g ? `\u{1F6DE} ${name}: Reifen ${WHEEL_DE[wheel]} verliert Luft${loss ? ` (\u2212${loss} bar in 7 Tagen)` : ""}. Bitte pr\xFCfen.` : `\u{1F6DE} ${name}: tyre ${WHEEL_EN[wheel]} is losing air${loss ? ` (\u2212${loss} bar in 7 days)` : ""}. Please check.`;
        });
      }
    }
  }
  checkFuel() {
    if (!this.on("fuel")) {
      return;
    }
    const g = this.options.german;
    const ranking = parseList(this.values.get("fuel.ranking"));
    const best = ranking[0];
    const cheap = !!best && best.rating === "cheap" && num(best.price) !== null;
    for (const slot of this.vehicleSlots()) {
      if (text(this.values.get(`ford.vehicle${slot}.engineType`)).toUpperCase() === "BEV") {
        continue;
      }
      const level = num(this.values.get(`ford.vehicle${slot}.fuelLevel`));
      if (level === null) {
        continue;
      }
      const key = `fuel.vehicle${slot}`;
      const last = this.sent[key];
      if (level > FUEL_REARM_LEVEL) {
        this.once(key, false);
        continue;
      }
      if ((last == null ? void 0 : last.active) && this.host.now() - last.at >= DAY_MS) {
        last.active = false;
      }
      if (level > FUEL_LEVEL || !cheap) {
        continue;
      }
      const name = text(this.values.get(`ford.vehicle${slot}.name`)) || `${g ? "Fahrzeug" : "Vehicle"} ${slot}`;
      const station = text(best.name);
      const price = fmt(num(best.price), 3, g);
      this.once(
        key,
        true,
        () => g ? `\u26FD ${name}: Tank ${fmt(level, 0, g)} % \xB7 ${station} ist gerade g\xFCnstig: ${price} \u20AC (Super E10)` : `\u26FD ${name}: tank ${fmt(level, 0, g)} % \xB7 ${station} is cheap right now: ${price} \u20AC (Super E10)`
      );
    }
  }
  // ---------------------------------------------------------------- helpers
  on(kind) {
    return this.options.kinds.has(kind);
  }
  vehicleSlots() {
    const slots = /* @__PURE__ */ new Set();
    for (const id of this.values.keys()) {
      const m = /^ford\.vehicle(\d+)\./.exec(id);
      if (m) {
        slots.add(Number(m[1]));
      }
    }
    return [...slots].sort();
  }
  /** Electric car that Ford reports as plugged in (the wallbox does not know the car) */
  pluggedCar() {
    for (const slot of this.vehicleSlots()) {
      const plug = text(this.values.get(`ford.vehicle${slot}.plugStatus`)).toUpperCase();
      if (text(this.values.get(`ford.vehicle${slot}.engineType`)).toUpperCase() === "BEV" && plug && plug !== "DISCONNECTED") {
        return { slot, name: text(this.values.get(`ford.vehicle${slot}.name`)) };
      }
    }
    return void 0;
  }
  /**
   * Sends when the condition starts; the condition ending re-arms it.
   *
   * @param key - Entry in the memory
   * @param active - Condition holds now
   * @param message - Text, called only when sending
   * @param dropOld - Remove entries of the same kind from other days (keys with a date)
   */
  once(key, active, message, dropOld = false) {
    const entry = this.sent[key];
    if (!active) {
      if (entry == null ? void 0 : entry.active) {
        entry.active = false;
        this.save();
      }
      return;
    }
    if ((entry == null ? void 0 : entry.active) || !message) {
      return;
    }
    if (dropOld) {
      const prefix = key.slice(0, key.lastIndexOf(".") + 1);
      for (const k of Object.keys(this.sent)) {
        if (k.startsWith(prefix) && k !== key) {
          delete this.sent[k];
        }
      }
    }
    this.sent[key] = { at: this.host.now(), active: true };
    this.save();
    this.send(message());
  }
  save() {
    void this.host.write(JSON.stringify(this.sent)).catch(() => void 0);
  }
  send(message) {
    this.queue = this.queue.then(async () => {
      try {
        await this.host.send(message);
        this.host.info(`Message sent: ${message}`);
      } catch (error) {
        this.host.warn(
          `Message not sent (${error instanceof Error ? error.message : String(error)}): ${message}`
        );
      }
    });
  }
}
function notifyInstance(value) {
  const instance = typeof value === "string" ? value.trim().replace(/^system\.adapter\./, "") : "";
  if (!instance) {
    return "telegram.0";
  }
  return /^[a-z0-9][a-z0-9_-]*\.\d{1,3}$/.test(instance) ? instance : void 0;
}
function notifyUsers(value) {
  const list = typeof value === "string" ? value : "";
  return [
    ...new Set(
      list.split(",").map((user) => user.trim()).filter(Boolean)
    )
  ];
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  FUEL_LEVEL,
  FUEL_REARM_LEVEL,
  NOTIFY_STATE,
  Notifier,
  fmt,
  notifyInstance,
  notifyUsers
});
//# sourceMappingURL=notifier.js.map
