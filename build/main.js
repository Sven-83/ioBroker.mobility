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
var import_promises = require("node:fs/promises");
var import_node_path = require("node:path");
var import_away_service = require("./lib/away/away-service");
var import_pdf_text = require("./lib/away/pdf-text");
var import_receipt_intake = require("./lib/away/receipt-intake");
var import_config = require("./lib/easee/config");
var import_easee_client = require("./lib/easee/easee-client");
var import_easee_service = require("./lib/easee/easee-service");
var import_sessions_sync = require("./lib/easee/sessions-sync");
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
var import_notifier = require("./lib/notify/notifier");
const NOTIFY_TIMEOUT_MS = 15e3;
const AWAY_FILE = "away-receipts.json";
const FUEL_HISTORY_FILE = "fuel-history.json";
class Mobility extends utils.Adapter {
  fuel;
  easee;
  ford;
  notifier;
  away;
  intake;
  /** telegram.N.communicate.pathFile while receipts are read */
  receiptPathId;
  /** telegram.N.communicate.request while receipts are read ("Laden 14 kWh") */
  receiptTextId;
  /** Connection state per running part; info.connection = all running parts connected */
  connections = /* @__PURE__ */ new Map();
  /** Last value written to info.connection (written only on change) */
  connectionWritten;
  /** Since when a part is not connected */
  partDownSince = /* @__PURE__ */ new Map();
  /** Ford vehicles that are not reachable */
  fordIssues = [];
  /** Last text written to info.issues (written only on change) */
  issuesWritten;
  constructor(options = {}) {
    super({
      ...options,
      name: "mobility"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    await this.setState("info.connection", false, true);
    await this.setState("info.issues", "[]", true);
    this.connectionWritten = false;
    await this.startNotifier();
    await this.startFuel();
    await this.startEasee();
    await this.startFord();
    await this.startAway();
    if (!this.fuel && !this.easee && !this.ford && !this.away) {
      this.log.info(
        "Nothing configured yet - enter fuel price, Easee and/or Ford settings in the instance settings"
      );
    }
  }
  /**
   * Writes a state with ack and lets the notifier read along.
   *
   * @param id - Relative state ID
   * @param value - Value
   */
  async write(id, value) {
    var _a;
    await this.setState(id, value, true);
    (_a = this.notifier) == null ? void 0 : _a.observe(id, value);
  }
  /** Starts the messages (Telegram) if they are switched on */
  async startNotifier() {
    var _a;
    const native = this.config;
    if (native.notifyEnabled !== true) {
      return;
    }
    const kinds = /* @__PURE__ */ new Set();
    if (native.notifyFull === true) {
      kinds.add("full");
    }
    for (const [field, kind] of [
      ["notifyFuel", "fuel"],
      ["notifyCharge", "charge"],
      ["notifyPlug", "plug"],
      ["notifyTyres", "tyres"]
    ]) {
      if (native[field] !== false) {
        kinds.add(kind);
      }
    }
    const german = await this.isGerman();
    this.notifier = new import_notifier.Notifier(
      {
        send: (text) => this.notify(text, native.notifyInstance, native.notifyUsers),
        read: async () => {
          var _a2, _b;
          return (_b = (_a2 = await this.getStateAsync(import_notifier.NOTIFY_STATE)) == null ? void 0 : _a2.val) != null ? _b : void 0;
        },
        write: (value) => this.setState(import_notifier.NOTIFY_STATE, value, true),
        now: () => Date.now(),
        info: (message) => this.log.info(message),
        warn: (message) => this.log.warn(message)
      },
      { kinds, german }
    );
    await this.notifier.start();
    this.log.info(
      `Messages: ${[...kinds].join(", ") || "none"} via ${(_a = (0, import_notifier.notifyInstance)(native.notifyInstance)) != null ? _a : "?"}`
    );
  }
  /** Language of the system is German */
  async isGerman() {
    var _a;
    try {
      const config = await this.getForeignObjectAsync("system.config");
      return ((_a = config == null ? void 0 : config.common) == null ? void 0 : _a.language) === "de";
    } catch {
      return false;
    }
  }
  /**
   * Sends a message through a messenger instance (telegram.0 by default). Text only.
   *
   * @param text - Message
   * @param instanceValue - Instance from the config
   * @param usersValue - Receivers from the config, empty for all
   */
  async notify(text, instanceValue, usersValue) {
    var _a;
    const instance = (0, import_notifier.notifyInstance)(instanceValue);
    if (!instance) {
      throw new Error("the instance for messages is not valid (example: telegram.0)");
    }
    if (!((_a = await this.getForeignStateAsync(`system.adapter.${instance}.alive`)) == null ? void 0 : _a.val)) {
      throw new Error(`${instance} is not running`);
    }
    const users = (0, import_notifier.notifyUsers)(usersValue);
    for (const user of users.length > 0 ? users : [void 0]) {
      const answer = await this.sendToAsync(instance, "send", user ? { text, user } : { text }, {
        timeout: NOTIFY_TIMEOUT_MS
      });
      if (answer && typeof answer === "object" && "error" in answer && answer.error) {
        throw new Error(`${instance}: ${typeof answer.error === "string" ? answer.error : "error"}`);
      }
      if (answer === 0) {
        throw new Error(
          `${instance} sent the message to nobody${user ? ` (receiver "${user}" unknown?)` : ""}`
        );
      }
    }
  }
  /**
   * Button "send a test message" in the instance settings.
   *
   * @param obj - Message from the admin
   */
  onMessage(obj) {
    var _a;
    if ((obj == null ? void 0 : obj.command) !== "notifyTest" || !obj.callback) {
      return;
    }
    const data = (_a = obj.message) != null ? _a : {};
    void (async () => {
      const german = await this.isGerman();
      const text = german ? "mobility: Testnachricht. Meldungen zu Tanken, Laden und Reifen kommen hier an." : "mobility: test message. Messages about fuel, charging and tyres arrive here.";
      try {
        await this.notify(text, data.instance, data.users);
        this.sendTo(obj.from, obj.command, { result: german ? "Gesendet" : "Sent" }, obj.callback);
      } catch (error) {
        this.sendTo(obj.from, obj.command, { error: error.message }, obj.callback);
      }
    })();
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
    await this.ensureFileStorage();
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
      setState: (id, value) => this.write(id, value),
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
  /** Meta object for the instance file storage (price memory, receipts) */
  async ensureFileStorage() {
    await this.setForeignObjectNotExistsAsync(this.namespace, {
      type: "meta",
      common: { name: "mobility data files", type: "meta.user" },
      native: {}
    });
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
      setState: (id, value) => this.write(id, value),
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
    this.easee.attachSessions(
      new import_sessions_sync.EaseeSessions(
        config.pricePerKwh,
        {
          getSessions: (serial, from, to) => client.getSessions(serial, from, to),
          log: this.log,
          now: () => Date.now(),
          setTimeout: (callback, ms) => this.setTimeout(callback, ms),
          clearTimeout: (handle) => this.clearTimeout(handle),
          ensureObjects: (definitions) => this.ensureObjects(definitions),
          setState: (id, value) => this.write(id, value),
          load: async (slot) => {
            try {
              const { file } = await this.readFileAsync(this.namespace, `easee-sessions-${slot}.json`);
              return file.toString();
            } catch {
              return void 0;
            }
          },
          save: (slot, text) => this.writeFileAsync(this.namespace, `easee-sessions-${slot}.json`, text)
        },
        config.sessionsFrom
      )
    );
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
      setState: (id, value) => this.write(id, value),
      onConnection: (connected) => this.setConnection("ford", connected),
      onIssues: (issues) => {
        this.fordIssues = issues;
        this.writeIssues();
      },
      loadHistory: async (slot) => {
        try {
          const { file } = await this.readFileAsync(this.namespace, `ford-history-${slot}.json`);
          return file.toString();
        } catch {
          return void 0;
        }
      },
      saveHistory: (slot, text) => this.writeFileAsync(this.namespace, `ford-history-${slot}.json`, text)
    });
    for (const v of config.vehicles) {
      for (const name of ["chargeLogs", "chargeLogsStatus"]) {
        const id = `${(0, import_objects2.vehicleChannel)(v.slot)}.${name}`;
        if (await this.getObjectAsync(id)) {
          await this.delObjectAsync(id);
        }
      }
    }
    await this.subscribeStatesAsync("ford.vehicle*.login.response");
    await this.subscribeStatesAsync("ford.vehicle*.refresh");
    await this.ford.start();
  }
  /** Starts reading charging receipts sent to the Telegram bot, if switched on */
  async startAway() {
    var _a, _b;
    const native = this.config;
    if (native.awayEnabled !== true) {
      return;
    }
    const instance = (0, import_notifier.notifyInstance)(native.notifyInstance);
    if (!instance) {
      this.log.warn("Charging on the road: the Telegram instance is not valid (example: telegram.0)");
      return;
    }
    const german = await this.isGerman();
    await this.ensureFileStorage();
    const away = new import_away_service.AwayService(
      {
        log: this.log,
        now: () => Date.now(),
        setTimeout: (callback, ms) => this.setTimeout(callback, ms),
        clearTimeout: (handle) => this.clearTimeout(handle),
        ensureObjects: (definitions) => this.ensureObjects(definitions),
        setState: (id, value) => this.write(id, value),
        load: async () => {
          try {
            return (await this.readFileAsync(this.namespace, AWAY_FILE)).file.toString();
          } catch {
            return void 0;
          }
        },
        save: (text) => this.writeFileAsync(this.namespace, AWAY_FILE, text)
      },
      german
    );
    this.away = away;
    await away.start();
    const folder = (0, import_node_path.resolve)(utils.getAbsoluteDefaultDataDir(), instance.replace(".", "_"), "document");
    const inFolder = (path) => {
      const full = (0, import_node_path.resolve)(path);
      if (!full.startsWith(folder + import_node_path.sep)) {
        throw new Error("file is not in the document folder of the telegram adapter");
      }
      return full;
    };
    const val = async (state) => {
      var _a2, _b2;
      return (_b2 = (_a2 = await this.getForeignStateAsync(`${instance}.communicate.${state}`)) == null ? void 0 : _a2.val) != null ? _b2 : void 0;
    };
    this.intake = new import_receipt_intake.ReceiptIntake(
      {
        senderId: async () => {
          const v = await val("requestUserId");
          return v === void 0 || v === "" ? void 0 : String(v);
        },
        chatId: async () => {
          const v = await val("requestChatId");
          return typeof v === "number" || typeof v === "string" && v ? v : void 0;
        },
        knownUsers: async () => (0, import_receipt_intake.parseUsers)(await val("users")),
        readFile: async (path) => {
          const full = inFolder(path);
          if ((await (0, import_promises.stat)(full)).size > import_pdf_text.MAX_PDF_BYTES) {
            throw new Error("PDF too large");
          }
          return (0, import_promises.readFile)(full);
        },
        deleteFile: (path) => (0, import_promises.unlink)(inFolder(path)),
        reply: async (chatId, text) => {
          await this.sendToAsync(instance, "send", chatId === void 0 ? { text } : { text, chatId }, {
            timeout: NOTIFY_TIMEOUT_MS
          });
        },
        add: (receipt) => away.add(receipt),
        removeLastManual: () => away.removeLastManual(),
        now: () => Date.now(),
        info: (message) => this.log.info(message),
        warn: (message) => this.log.warn(message)
      },
      german
    );
    this.receiptPathId = `${instance}.communicate.pathFile`;
    this.receiptTextId = `${instance}.communicate.request`;
    await this.subscribeForeignStatesAsync(this.receiptPathId);
    await this.subscribeForeignStatesAsync(this.receiptTextId);
    const telegram = (_b = (_a = await this.getForeignObjectAsync(`system.adapter.${instance}`)) == null ? void 0 : _a.native) != null ? _b : {};
    if (telegram.saveFiles !== true || telegram.saveFilesTo !== "filesystem") {
      this.log.warn(
        `Charging on the road: in ${instance} switch on "Save files" with location "file system", otherwise receipts sent to the bot are not stored`
      );
    }
    this.log.info(`Charging on the road: ${away.count} receipts; PDFs sent to ${instance} are read`);
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
    if (id === this.receiptPathId && this.intake) {
      if (state && typeof state.val === "string" && state.val) {
        this.intake.handle(state.val).catch((error) => this.log.warn(`Charging on the road: ${error.message}`));
      }
      return;
    }
    if (id === this.receiptTextId && this.intake) {
      if (state && typeof state.val === "string" && state.val) {
        this.intake.handleText(state.val).catch((error) => this.log.warn(`Charging on the road: ${error.message}`));
      }
      return;
    }
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
    if (connected) {
      this.partDownSince.delete(part);
    } else if (!this.partDownSince.has(part)) {
      this.partDownSince.set(part, Date.now());
    }
    const all = [...this.connections.values()].every(Boolean);
    if (all !== this.connectionWritten) {
      this.connectionWritten = all;
      void this.setState("info.connection", all, true);
    }
    this.writeIssues();
  }
  /**
   * info.issues: which part or which vehicle does not deliver data, so a watcher or the dashboard
   * can name it while the rest keeps working. JSON list, empty = everything fine.
   * Entry: { part: fuel|easee|ford, name?, problem?, since, lastData? }
   */
  writeIssues() {
    const list = [];
    for (const [part, since] of this.partDownSince) {
      if (part === "ford" && this.fordIssues.length) {
        continue;
      }
      list.push({ part, since });
    }
    for (const issue of this.fordIssues) {
      list.push({
        part: "ford",
        name: issue.name,
        problem: issue.problem,
        since: issue.since,
        lastData: issue.lastData
      });
    }
    const text = JSON.stringify(list);
    if (text !== this.issuesWritten) {
      this.issuesWritten = text;
      void this.setState("info.issues", text, true);
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
    var _a, _b, _c, _d;
    try {
      (_a = this.fuel) == null ? void 0 : _a.stop();
      (_b = this.easee) == null ? void 0 : _b.stop();
      (_c = this.ford) == null ? void 0 : _c.stop();
      (_d = this.away) == null ? void 0 : _d.stop();
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
