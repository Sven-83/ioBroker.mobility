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
var stream_exports = {};
__export(stream_exports, {
  EaseeStream: () => EaseeStream,
  HANDSHAKE_TIMEOUT_MS: () => HANDSHAKE_TIMEOUT_MS,
  HUB_URL: () => HUB_URL,
  MAX_RECONNECT_MS: () => MAX_RECONNECT_MS,
  MIN_RECONNECT_MS: () => MIN_RECONNECT_MS,
  PING_INTERVAL_MS: () => PING_INTERVAL_MS,
  SILENCE_TIMEOUT_MS: () => SILENCE_TIMEOUT_MS,
  STABLE_AFTER_MS: () => STABLE_AFTER_MS,
  cookieHeader: () => cookieHeader
});
module.exports = __toCommonJS(stream_exports);
var import_errors = require("../fuel/errors");
var import_http = require("../util/http");
var import_errors2 = require("./errors");
const HUB_URL = "https://streams.easee.com/hubs/products";
const RS = "";
const PING_INTERVAL_MS = 15e3;
const SILENCE_TIMEOUT_MS = 6e4;
const HANDSHAKE_TIMEOUT_MS = 15e3;
const MIN_RECONNECT_MS = 5e3;
const MAX_RECONNECT_MS = 5 * 6e4;
const STABLE_AFTER_MS = 2 * 6e4;
class EaseeStream {
  /**
   * @param deps - Dependencies
   * @param hubUrl - Hub URL (tests)
   */
  constructor(deps, hubUrl = HUB_URL) {
    this.deps = deps;
    this.hubUrl = hubUrl;
  }
  socket;
  serials = [];
  timers = /* @__PURE__ */ new Map();
  stopped = true;
  connected = false;
  handshakeDone = false;
  buffer = "";
  lastMessageAt = 0;
  connectedAt = 0;
  attempts = 0;
  invocationId = 0;
  failureLogged = false;
  /** Stream is up */
  isConnected() {
    return this.connected;
  }
  /**
   * Connects and subscribes the given chargers.
   *
   * @param serials - Serial numbers
   */
  start(serials) {
    this.serials = [...serials];
    this.stopped = false;
    void this.connect();
  }
  /** Closes the connection for good */
  stop() {
    this.stopped = true;
    for (const handle of this.timers.values()) {
      this.deps.clearTimeout(handle);
    }
    this.timers.clear();
    this.closeSocket();
    this.setConnected(false);
  }
  /**
   * Subscribes one charger again (stream may go silent after start/stop).
   *
   * @param serial - Serial number
   */
  resubscribe(serial) {
    if (this.connected && this.serials.includes(serial)) {
      this.subscribe(serial);
    }
  }
  async connect() {
    if (this.stopped) {
      return;
    }
    this.closeSocket();
    try {
      const token = await this.deps.getToken();
      const { url, headers } = await this.negotiate(token);
      if (this.stopped) {
        return;
      }
      this.open(url, headers);
    } catch (error) {
      if (error instanceof import_errors2.EaseeAuthError) {
        this.stop();
        return;
      }
      this.failed(`connect failed: ${(0, import_errors.describeError)(error)}`);
    }
  }
  /**
   * @param token - Access token
   * @returns WebSocket URL (wss, with connection token and access token) and headers
   */
  async negotiate(token) {
    var _a, _b;
    let response;
    try {
      response = await this.deps.fetch(`${this.hubUrl}/negotiate?negotiateVersion=1`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Length": "0" },
        signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS)
      });
    } catch (error) {
      throw new Error(`negotiate: no answer (${(0, import_http.networkReason)(error)})`);
    }
    const wsBase = this.hubUrl.replace(/^http/, "ws");
    const headers = { Authorization: `Bearer ${token}` };
    if (response.status === 404 || response.status === 405) {
      await ((_a = response.body) == null ? void 0 : _a.cancel().catch(() => void 0));
      return { url: `${wsBase}?access_token=${encodeURIComponent(token)}`, headers };
    }
    if (!response.ok) {
      await ((_b = response.body) == null ? void 0 : _b.cancel().catch(() => void 0));
      throw new Error(`negotiate: HTTP ${response.status}`);
    }
    const body = await response.json().catch(() => ({}));
    if (typeof body.url === "string" && typeof body.accessToken === "string") {
      const redirect = body.url.replace(/^http/, "ws");
      const sep = redirect.includes("?") ? "&" : "?";
      return {
        url: `${redirect}${sep}access_token=${encodeURIComponent(body.accessToken)}`,
        headers: { Authorization: `Bearer ${body.accessToken}` }
      };
    }
    const id = typeof body.connectionToken === "string" ? body.connectionToken : typeof body.connectionId === "string" ? body.connectionId : "";
    if (!id) {
      throw new Error("negotiate: no connection token");
    }
    const cookies = cookieHeader(response.headers);
    if (cookies) {
      headers.Cookie = cookies;
    }
    return {
      url: `${wsBase}?id=${encodeURIComponent(id)}&access_token=${encodeURIComponent(token)}`,
      headers
    };
  }
  /**
   * @param url - WebSocket URL
   * @param headers - Headers
   */
  open(url, headers) {
    let socket;
    try {
      socket = this.deps.createSocket(url, headers);
    } catch (error) {
      this.failed(`WebSocket could not be created: ${(0, import_http.networkReason)(error)}`);
      return;
    }
    this.socket = socket;
    this.handshakeDone = false;
    this.buffer = "";
    this.lastMessageAt = this.deps.now();
    socket.onopen = () => {
      socket.send(`${JSON.stringify({ protocol: "json", version: 1 })}${RS}`);
      this.timer("handshake", HANDSHAKE_TIMEOUT_MS, () => this.drop("no handshake answer"));
    };
    socket.onmessage = (event) => {
      if (socket === this.socket) {
        this.receive(typeof event.data === "string" ? event.data : String(event.data));
      }
    };
    socket.onerror = () => {
    };
    socket.onclose = (event) => {
      if (socket === this.socket) {
        this.socket = void 0;
        this.drop(`closed (code ${event.code})`);
      }
    };
  }
  /**
   * @param data - Text frame (one or more records)
   */
  receive(data) {
    this.lastMessageAt = this.deps.now();
    this.buffer += data;
    let index;
    while ((index = this.buffer.indexOf(RS)) >= 0) {
      const record = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (record.trim() !== "") {
        this.handleRecord(record);
      }
    }
    if (this.buffer.length > 1e6) {
      this.drop("oversized message");
    }
  }
  /**
   * @param record - One JSON record
   */
  handleRecord(record) {
    let message;
    try {
      message = JSON.parse(record);
    } catch {
      this.deps.log.debug("Easee stream: ignored a record that is not JSON");
      return;
    }
    if (!this.handshakeDone) {
      this.clearTimer("handshake");
      if (typeof message.error === "string") {
        this.drop(`handshake refused (${message.error.slice(0, 100)})`);
        return;
      }
      this.handshakeDone = true;
      this.onHandshake();
      return;
    }
    switch (message.type) {
      case 1:
        this.handleInvocation(message);
        break;
      case 3:
        if (typeof message.error === "string") {
          this.deps.log.warn(`Easee stream: subscription failed (${message.error.slice(0, 100)})`);
        }
        break;
      case 7:
        this.drop(
          `server closed the stream${typeof message.error === "string" ? ` (${message.error.slice(0, 100)})` : ""}`
        );
        break;
      default:
        break;
    }
  }
  onHandshake() {
    this.connectedAt = this.deps.now();
    for (const serial of this.serials) {
      this.subscribe(serial);
    }
    this.setConnected(true);
    if (this.failureLogged) {
      this.deps.log.info("Easee stream connected again");
      this.failureLogged = false;
    } else {
      this.deps.log.info("Easee stream connected (real-time values)");
    }
    this.schedulePing();
  }
  /**
   * @param message - Invocation
   */
  handleInvocation(message) {
    const args = Array.isArray(message.arguments) ? message.arguments : [];
    if (message.target !== "ProductUpdate") {
      return;
    }
    for (const arg of args) {
      const raw = arg != null ? arg : {};
      const serial = typeof raw.mid === "string" ? raw.mid.toUpperCase() : "";
      if (!this.serials.includes(serial) || typeof raw.id !== "number") {
        continue;
      }
      this.deps.onObservation(serial, {
        id: raw.id,
        value: raw.value,
        timestamp: typeof raw.timestamp === "string" ? raw.timestamp : ""
      });
    }
  }
  /**
   * @param serial - Serial number
   */
  subscribe(serial) {
    this.invocationId++;
    this.sendRecord({
      type: 1,
      invocationId: String(this.invocationId),
      target: "SubscribeWithCurrentState",
      arguments: [serial, true]
    });
  }
  schedulePing() {
    this.timer("ping", PING_INTERVAL_MS, () => {
      if (!this.connected) {
        return;
      }
      if (this.deps.now() - this.lastMessageAt >= SILENCE_TIMEOUT_MS) {
        this.drop("no message for 60 s");
        return;
      }
      if (this.deps.now() - this.connectedAt >= STABLE_AFTER_MS) {
        this.attempts = 0;
      }
      this.sendRecord({ type: 6 });
      this.schedulePing();
    });
  }
  /**
   * @param message - SignalR message
   */
  sendRecord(message) {
    var _a;
    try {
      (_a = this.socket) == null ? void 0 : _a.send(`${JSON.stringify(message)}${RS}`);
    } catch (error) {
      this.drop(`send failed (${(0, import_http.networkReason)(error)})`);
    }
  }
  /**
   * Connection lost or unusable: close and reconnect with backoff.
   *
   * @param reason - Text for the log
   */
  drop(reason) {
    this.closeSocket();
    this.failed(reason);
  }
  /**
   * @param reason - Text for the log
   */
  failed(reason) {
    this.setConnected(false);
    if (this.stopped) {
      return;
    }
    this.attempts++;
    const delay = Math.min(MIN_RECONNECT_MS * 2 ** (this.attempts - 1), MAX_RECONNECT_MS);
    const message = `Easee stream: ${reason}; reconnect in ${Math.round(delay / 1e3)} s (values are polled meanwhile)`;
    if (this.failureLogged) {
      this.deps.log.debug(message);
    } else {
      this.deps.log.info(message);
      this.failureLogged = true;
    }
    this.timer("reconnect", delay, () => void this.connect());
  }
  closeSocket() {
    this.clearTimer("ping");
    this.clearTimer("handshake");
    const socket = this.socket;
    this.socket = void 0;
    this.handshakeDone = false;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(1e3);
      } catch {
      }
    }
  }
  /**
   * @param connected - New state
   */
  setConnected(connected) {
    if (this.connected !== connected) {
      this.connected = connected;
      this.deps.onConnection(connected);
    }
  }
  /**
   * @param name - Timer slot
   * @param ms - Delay
   * @param callback - Work
   */
  timer(name, ms, callback) {
    this.clearTimer(name);
    const handle = this.deps.setTimeout(() => {
      this.timers.delete(name);
      if (!this.stopped) {
        callback();
      }
    }, ms);
    this.timers.set(name, handle);
  }
  /**
   * @param name - Timer slot
   */
  clearTimer(name) {
    const handle = this.timers.get(name);
    if (handle !== void 0) {
      this.deps.clearTimeout(handle);
      this.timers.delete(name);
    }
  }
}
function cookieHeader(headers) {
  const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  return list.map((cookie) => cookie.split(";")[0].trim()).filter((pair) => /^[\w.-]+=/.test(pair)).join("; ");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  EaseeStream,
  HANDSHAKE_TIMEOUT_MS,
  HUB_URL,
  MAX_RECONNECT_MS,
  MIN_RECONNECT_MS,
  PING_INTERVAL_MS,
  SILENCE_TIMEOUT_MS,
  STABLE_AFTER_MS,
  cookieHeader
});
//# sourceMappingURL=stream.js.map
