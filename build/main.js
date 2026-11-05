"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_node_crypto = require("node:crypto");
var import_config = require("./lib/easee/config");
var import_easee_client = require("./lib/easee/easee-client");
var import_easee_service = require("./lib/easee/easee-service");
var import_stream = require("./lib/easee/stream");
var import_objects = require("./lib/easee/objects");
var import_config2 = require("./lib/ford/config");
var import_ford_client = require("./lib/ford/ford-client");
var import_ford_service = require("./lib/ford/ford-service");
var import_objects2 = require("./lib/ford/objects");
var import_config3 = require("./lib/fuel/config");
var import_fuel_service = require("./lib/fuel/fuel-service");
var import_objects3 = require("./lib/fuel/objects");
var import_tankerkoenig = require("./lib/fuel/tankerkoenig");
const FUEL_HISTORY_FILE = "fuel-history.json";
class Mobility extends utils.Adapter {
  fuel;
  easee;
  ford;
  /** Connection state per running part; info.connection = all running parts connected */
  connections = /* @__PURE__ */ new Map();
  /** Last value written to info.connection (written only on change) */
  connectionWritten;
  constructor(options = {}) {
    super({
      ...options,
      name: "mobility"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    await this.setState("info.connection", false, true);
    this.connectionWritten = false;
    await this.startFuel();
    await this.startEasee();
    await this.startFord();
    if (!this.fuel && !this.easee && !this.ford) {
      this.log.info(
        "Nothing configured yet - enter fuel price, Easee and/or Ford settings in the instance settings"
      );
    }
  }
  /** Validates the fuel config and starts the fuel service if it is complete */
  async startFuel() {
    const { config, problems } = (0, import_config3.readFuelConfig)(this.config);
    for (const problem of problems) {
      this.log.warn(`Fuel prices: ${problem}`);
    }
    if (!config.enabled) {
      if (this.config.fuelEnabled !== false && (config.apiKey || config.stations.length > 0)) {
        this.log.warn("Fuel prices: API key or stations missing - fuel prices stay off");
      }
      return;
    }
    await this.setForeignObjectNotExistsAsync(this.namespace, {
      type: "meta",
      common: { name: "mobility data files", type: "meta.user" },
      native: {}
    });
    const client = new import_tankerkoenig.TankerkoenigClient(config.apiKey);
    this.fuel = new import_fuel_service.FuelService(config, {
      client,
      log: this.log,
      now: () => Date.now(),
      random: () => Math.random(),
      setTimeout: (callback, ms) => this.setTimeout(callback, ms),
      clearTimeout: (handle) => this.clearTimeout(handle),
      ensureObjects: (definitions) => this.ensureObjects(definitions),
      removeStationsExcept: (slots) => this.removeChannelsExcept(`${import_objects3.FUEL_ROOT}.station`, slots, "Fuel prices", true),
      setState: async (id, value) => {
        await this.setState(id, value, true);
      },
      loadHistory: async () => {
        try {
          const { file } = await this.readFileAsync(this.namespace, FUEL_HISTORY_FILE);
          return file.toString();
        } catch {
          return void 0;
        }
      },
      saveHistory: (text) => this.writeFileAsync(this.namespace, FUEL_HISTORY_FILE, text),
      onConnection: (connected) => this.setConnection("fuel", connected)
    });
    await this.fuel.start();
  }
  /** Validates the Easee config and starts the Easee service if it is complete */
  async startEasee() {
    const { config, problems } = (0, import_config.readEaseeConfig)(this.config);
    for (const problem of problems) {
      this.log.warn(`Easee: ${problem}`);
    }
    if (!config.enabled) {
      return;
    }
    const client = new import_easee_client.EaseeClient(config.userName, config.password);
    this.easee = new import_easee_service.EaseeService(config, {
      client,
      log: this.log,
      now: () => Date.now(),
      random: () => Math.random(),
      setTimeout: (callback, ms) => this.setTimeout(callback, ms),
      clearTimeout: (handle) => this.clearTimeout(handle),
      ensureObjects: (definitions) => this.ensureObjects(definitions),
      removeChargersExcept: (slots) => this.removeChannelsExcept(`${import_objects.EASEE_ROOT}.charger`, slots, "Easee", false),
      setState: async (id, value) => {
        await this.setState(id, value, true);
      },
      onConnection: (connected) => this.setConnection("easee", connected)
    });
    if (config.stream) {
      const service = this.easee;
      service.attachStream(
        new import_stream.EaseeStream({
          getToken: () => client.accessToken(),
          createSocket: (url, headers) => new WebSocket(url, { headers }),
          fetch: (input, init) => fetch(input, init),
          log: this.log,
          now: () => Date.now(),
          setTimeout: (callback, ms) => this.setTimeout(callback, ms),
          clearTimeout: (handle) => this.clearTimeout(handle),
          onObservation: (serial, observation) => service.pushObservation(serial, observation),
          onConnection: (connected) => service.streamConnection(connected)
        })
      );
    }
    await this.subscribeStatesAsync(`${import_objects.EASEE_ROOT}.charger*.charge`);
    await this.subscribeStatesAsync(`${import_objects.EASEE_ROOT}.charger*.refresh`);
    this.easee.start();
  }
  /** Validates the Ford config and starts the Ford service if it is complete */
  async startFord() {
    const { config, problems } = (0, import_config2.readFordConfig)(this.config);
    for (const problem of problems) {
      this.log.warn(`Ford: ${problem}`);
    }
    if (!config.enabled) {
      return;
    }
    this.ford = new import_ford_service.FordService(config, {
      createClient: (slot) => new import_ford_client.FordClient(config.clientId, config.clientSecret, config.redirectUri, {
        load: () => this.loadFordToken(slot),
        save: (token) => this.saveFordToken(slot, token)
      }),
      log: this.log,
      now: () => Date.now(),
      random: () => Math.random(),
      randomState: () => (0, import_node_crypto.randomBytes)(8).toString("hex"),
      setTimeout: (callback, ms) => this.setTimeout(callback, ms),
      clearTimeout: (handle) => this.clearTimeout(handle),
      ensureObjects: (definitions) => this.ensureObjects(definitions),
      setState: async (id, value) => {
        await this.setState(id, value, true);
      },
      onConnection: (connected) => this.setConnection("ford", connected)
    });
    await this.subscribeStatesAsync("ford.vehicle*.login.response");
    await this.subscribeStatesAsync("ford.vehicle*.refresh");
    await this.ford.start();
  }
  /**
   * Ford token of one vehicle, stored encrypted (system secret) in ford.vehicleN.login.token.
   *
   * @param slot - Vehicle slot
   */
  async loadFordToken(slot) {
    const state = await this.getStateAsync(`${(0, import_objects2.vehicleChannel)(slot)}.login.token`);
    if (typeof (state == null ? void 0 : state.val) !== "string" || state.val === "") {
      return void 0;
    }
    try {
      const token = JSON.parse(this.decrypt(state.val));
      return typeof token.access === "string" && typeof token.refresh === "string" ? token : void 0;
    } catch {
      this.log.warn(`Ford: stored login of vehicle ${slot} could not be read - please log in again`);
      return void 0;
    }
  }
  /**
   * @param slot - Vehicle slot
   * @param token - Token, undefined = forget
   */
  async saveFordToken(slot, token) {
    await this.setState(
      `${(0, import_objects2.vehicleChannel)(slot)}.login.token`,
      token ? this.encrypt(JSON.stringify(token)) : "",
      true
    );
  }
  /**
   * Commands from VIS / scripts (only writes with ack=false).
   *
   * @param id - Full state ID
   * @param state - New state
   */
  onStateChange(id, state) {
    if (!state || state.ack) {
      return;
    }
    const vehicle = (0, import_objects2.parseVehicleCommandId)(this.namespace, id);
    if (vehicle && this.ford) {
      if (vehicle.command === "refresh") {
        this.ford.requestPoll(vehicle.slot);
      } else {
        void this.ford.handleLoginResponse(vehicle.slot, typeof state.val === "string" ? state.val : "");
      }
      return;
    }
    if (!this.easee) {
      return;
    }
    const target = (0, import_objects.parseChargerCommandId)(this.namespace, id);
    if (!target) {
      return;
    }
    if (target.command === "refresh") {
      this.easee.requestPoll(0);
      return;
    }
    if (typeof state.val !== "boolean") {
      this.log.warn(`Easee: ${id} expects true or false`);
      return;
    }
    void this.easee.setCharging(target.slot, state.val);
  }
  /**
   * @param part - fuel / easee
   * @param connected - Connection state of that part
   */
  setConnection(part, connected) {
    this.connections.set(part, connected);
    const all = [...this.connections.values()].every(Boolean);
    if (all !== this.connectionWritten) {
      this.connectionWritten = all;
      void this.setState("info.connection", all, true);
    }
  }
  /**
   * Creates or updates objects (names may change in the config).
   *
   * @param definitions - Objects relative to the namespace
   */
  async ensureObjects(definitions) {
    for (const definition of definitions) {
      await this.extendObject(definition.id, definition.obj);
    }
  }
  /**
   * Handles numbered channels (fuel stations, chargers) whose slot is no longer in use.
   * Rule of the owner (2026-11-05): nothing that has to do with Easee is ever deleted - those
   * channels stay and the log only says where they are. Fuel station channels may be removed.
   *
   * @param relativePrefix - e.g. "fuel.station" or "easee.charger"
   * @param slots - Slots that are still in use
   * @param part - Name for the log
   * @param mayDelete - true only for the fuel part
   */
  async removeChannelsExcept(relativePrefix, slots, part, mayDelete) {
    const prefix = `${this.namespace}.${relativePrefix}`;
    const channels = await this.getForeignObjectsAsync(`${prefix}*`, "channel");
    for (const id of Object.keys(channels)) {
      const slot = Number(id.slice(prefix.length));
      if (!Number.isInteger(slot) || slots.includes(slot)) {
        continue;
      }
      if (mayDelete) {
        this.log.info(`${part}: removing ${id} (no longer in use)`);
        await this.delForeignObjectAsync(id, { recursive: true });
      } else {
        this.log.info(`${part}: ${id} is no longer in use - kept (Easee objects are never deleted)`);
      }
    }
  }
  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   *
   * @param callback - Callback function
   */
  onUnload(callback) {
    var _a, _b, _c;
    try {
      (_a = this.fuel) == null ? void 0 : _a.stop();
      (_b = this.easee) == null ? void 0 : _b.stop();
      (_c = this.ford) == null ? void 0 : _c.stop();
      void this.setState("info.connection", false, true);
      callback();
    } catch (error) {
      this.log.error(`Error during unloading: ${error.message}`);
      callback();
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new Mobility(options);
} else {
  (() => new Mobility())();
}
//# sourceMappingURL=main.js.map
