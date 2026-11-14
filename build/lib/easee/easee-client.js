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
var easee_client_exports = {};
__export(easee_client_exports, {
  BASE_URL: () => BASE_URL,
  DEFAULT_RATE_LIMIT_WAIT_MS: () => DEFAULT_RATE_LIMIT_WAIT_MS,
  EaseeClient: () => EaseeClient,
  HTTP_TIMEOUT_MS: () => HTTP_TIMEOUT_MS,
  SERIAL_PATTERN: () => SERIAL_PATTERN,
  TOKEN_MARGIN_MS: () => TOKEN_MARGIN_MS,
  isAllowedRequest: () => isAllowedRequest,
  isoSeconds: () => isoSeconds
});
module.exports = __toCommonJS(easee_client_exports);
var import_errors = require("./errors");
var import_observations = require("./observations");
var import_sessions = require("./sessions");
var import_http = require("../util/http");
const BASE_URL = "https://api.easee.com";
const HTTP_TIMEOUT_MS = 15e3;
const TOKEN_MARGIN_MS = 5 * 6e4;
const DEFAULT_RATE_LIMIT_WAIT_MS = 5 * 6e4;
const SERIAL_PATTERN = /^[A-Z0-9]{6,16}$/;
class EaseeClient {
  /**
   * @param userName - E-mail or phone number of the Easee account
   * @param password - Password (kept in memory only)
   * @param options - Optional settings
   */
  constructor(userName, password, options = {}) {
    this.userName = userName;
    this.password = password;
    var _a, _b, _c, _d;
    this.fetchFn = (_a = options.fetch) != null ? _a : ((input, init) => fetch(input, init));
    this.baseUrl = (_b = options.baseUrl) != null ? _b : BASE_URL;
    this.timeoutMs = (_c = options.timeoutMs) != null ? _c : HTTP_TIMEOUT_MS;
    this.now = (_d = options.now) != null ? _d : Date.now;
  }
  fetchFn;
  baseUrl;
  timeoutMs;
  now;
  shutdown = new AbortController();
  token;
  pendingToken;
  /** Chargers of the account, sorted by serial (stable slot order) */
  async getChargers() {
    const body = await this.authorized("GET", "/api/chargers", "chargers");
    if (!Array.isArray(body)) {
      throw new import_errors.EaseeResponseError("chargers: unexpected answer (no list)");
    }
    const chargers = [];
    for (const entry of body) {
      const raw = entry != null ? entry : {};
      const serial = typeof raw.id === "string" ? raw.id.trim().toUpperCase() : "";
      if (!SERIAL_PATTERN.test(serial)) {
        continue;
      }
      const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 60) : "";
      chargers.push({ serial, name });
    }
    return chargers.sort((a, b) => a.serial.localeCompare(b.serial));
  }
  /**
   * Current observations of one charger.
   *
   * @param serial - Serial number
   * @param ids - Observation IDs, defaults to everything the adapter uses
   */
  async getObservations(serial, ids = import_observations.OBSERVATION_IDS) {
    const query = new URLSearchParams({ ids: ids.join(",") });
    const body = await this.authorized(
      "GET",
      `/state/${checkSerial(serial)}/observations?${query.toString()}`,
      "observations"
    );
    const list = body == null ? void 0 : body.observations;
    if (!Array.isArray(list)) {
      throw new import_errors.EaseeResponseError("observations: unexpected answer (no observations list)");
    }
    const result = [];
    for (const entry of list) {
      const raw = entry != null ? entry : {};
      if (typeof raw.id !== "number" || !Number.isInteger(raw.id)) {
        continue;
      }
      result.push({
        id: raw.id,
        value: raw.value,
        timestamp: typeof raw.timestamp === "string" ? raw.timestamp : ""
      });
    }
    return result;
  }
  /**
   * Sends a charging command.
   *
   * @param serial - Serial number
   * @param command - Command
   */
  async command(serial, command) {
    await this.authorized("POST", `/api/chargers/${checkSerial(serial)}/commands/${command}`, command);
  }
  /**
   * Charging sessions of one charger between two times.
   *
   * @param serial - Serial number
   * @param from - Start (epoch ms)
   * @param to - End (epoch ms)
   */
  async getSessions(serial, from, to) {
    const body = await this.authorized(
      "GET",
      `/api/sessions/charger/${checkSerial(serial)}/sessions/${isoSeconds(from)}/${isoSeconds(to)}`,
      "sessions"
    );
    const list = (0, import_sessions.parseSessions)(body != null ? body : []);
    if (!list) {
      throw new import_errors.EaseeResponseError("sessions: unexpected answer (no list)");
    }
    return list;
  }
  /** Valid access token for the SignalR stream (shares login and refresh with REST) */
  async accessToken() {
    return (await this.validToken()).access;
  }
  /** Cancels running requests (adapter unload) */
  abort() {
    this.shutdown.abort();
  }
  /**
   * Request with a valid access token; one retry with a new token after HTTP 401.
   *
   * @param method - GET / POST
   * @param path - Path incl. query
   * @param label - Short name for messages (never the path, it contains the serial)
   */
  async authorized(method, path, label) {
    var _a;
    for (let attempt = 0; ; attempt++) {
      const token = await this.validToken();
      const response = await this.send(method, path, label, void 0, token.access);
      if (response.status === 401 && attempt === 0) {
        await ((_a = response.body) == null ? void 0 : _a.cancel().catch(() => void 0));
        if (this.token === token) {
          this.token = { ...token, expiresAt: 0 };
        }
        continue;
      }
      return this.readJson(response, label);
    }
  }
  /** Access token that is valid for at least TOKEN_MARGIN_MS; parallel callers share one login */
  async validToken() {
    var _a;
    if (this.token && this.token.expiresAt - TOKEN_MARGIN_MS > this.now()) {
      return this.token;
    }
    (_a = this.pendingToken) != null ? _a : this.pendingToken = this.renewToken().finally(() => {
      this.pendingToken = void 0;
    });
    return this.pendingToken;
  }
  async renewToken() {
    var _a, _b;
    const old = this.token;
    if (old == null ? void 0 : old.refresh) {
      try {
        const response2 = await this.send(
          "POST",
          "/api/accounts/refresh_token",
          "token refresh",
          { refreshToken: old.refresh },
          old.access
        );
        if (response2.ok) {
          this.token = this.parseToken(await this.readJson(response2, "token refresh"), old.refresh);
          return this.token;
        }
        await ((_a = response2.body) == null ? void 0 : _a.cancel().catch(() => void 0));
        if (response2.status === 429) {
          throw rateLimited(response2, "token refresh", this.now());
        }
      } catch (error) {
        if (!(error instanceof import_errors.EaseeResponseError)) {
          throw error;
        }
      }
    }
    this.token = void 0;
    const response = await this.send("POST", "/api/accounts/login", "login", {
      userName: this.userName,
      password: this.password
    });
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      await ((_b = response.body) == null ? void 0 : _b.cancel().catch(() => void 0));
      throw new import_errors.EaseeAuthError(`login rejected (HTTP ${response.status}) - check user name and password`);
    }
    this.token = this.parseToken(await this.readJson(response, "login"), "");
    return this.token;
  }
  /**
   * @param body - Token answer
   * @param previousRefresh - Kept when the answer has no new refresh token
   */
  parseToken(body, previousRefresh) {
    const raw = body != null ? body : {};
    if (typeof raw.accessToken !== "string" || raw.accessToken === "") {
      throw new import_errors.EaseeResponseError("token: unexpected answer (no access token)");
    }
    const expiresIn = typeof raw.expiresIn === "number" && raw.expiresIn > 0 ? raw.expiresIn : 3600;
    return {
      access: raw.accessToken,
      refresh: typeof raw.refreshToken === "string" && raw.refreshToken ? raw.refreshToken : previousRefresh,
      expiresAt: this.now() + expiresIn * 1e3
    };
  }
  /**
   * Raw request with timeout and shutdown handling.
   *
   * @param method - GET / POST
   * @param path - Path incl. query
   * @param label - Short name for messages
   * @param json - JSON body
   * @param bearer - Access token
   */
  async send(method, path, label, json, bearer) {
    if (!isAllowedRequest(method, path)) {
      throw new import_errors.EaseeResponseError(`${label}: request blocked (not on the allow list)`);
    }
    const headers = { Accept: "application/json" };
    if (json) {
      headers["Content-Type"] = "application/json";
    }
    if (bearer) {
      headers.Authorization = `Bearer ${bearer}`;
    }
    try {
      return await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: json ? JSON.stringify(json) : method === "POST" ? "" : void 0,
        signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(this.timeoutMs)])
      });
    } catch (error) {
      if (this.shutdown.signal.aborted) {
        throw new import_errors.EaseeAbortedError("Request aborted (shutdown)");
      }
      throw new import_errors.EaseeNetworkError(`${label}: no answer (${(0, import_http.networkReason)(error)})`);
    }
  }
  /**
   * Maps status codes and parses JSON (empty body -> null).
   *
   * @param response - Answer
   * @param label - Short name for messages
   */
  async readJson(response, label) {
    var _a;
    if (response.status === 429) {
      await ((_a = response.body) == null ? void 0 : _a.cancel().catch(() => void 0));
      throw rateLimited(response, label, this.now());
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      throw new import_errors.EaseeResponseError(`${label}: HTTP ${response.status}`, response.status);
    }
    if (text.trim() === "") {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new import_errors.EaseeResponseError(`${label}: HTTP ${response.status}, answer is not JSON`, response.status);
    }
  }
}
function rateLimited(response, label, now) {
  var _a;
  const waitMs = (_a = (0, import_http.parseRetryAfter)(response.headers.get("retry-after"), now)) != null ? _a : DEFAULT_RATE_LIMIT_WAIT_MS;
  return new import_errors.EaseeRateLimitedError(`${label}: too many requests (HTTP 429)`, waitMs);
}
const ALLOWED_REQUESTS = [
  { method: "POST", path: /^\/api\/accounts\/login$/ },
  { method: "POST", path: /^\/api\/accounts\/refresh_token$/ },
  { method: "GET", path: /^\/api\/chargers$/ },
  { method: "GET", path: /^\/state\/[A-Z0-9]{6,16}\/observations\?ids=[0-9%C,]+$/ },
  // charging sessions (read only)
  {
    method: "GET",
    path: /^\/api\/sessions\/charger\/[A-Z0-9]{6,16}\/sessions\/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
  },
  {
    method: "POST",
    path: /^\/api\/chargers\/[A-Z0-9]{6,16}\/commands\/(start_charging|stop_charging|pause_charging|resume_charging)$/
  }
];
function isAllowedRequest(method, path) {
  return ALLOWED_REQUESTS.some((rule) => rule.method === method && rule.path.test(path));
}
function isoSeconds(t) {
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
}
function checkSerial(serial) {
  if (!SERIAL_PATTERN.test(serial)) {
    throw new import_errors.EaseeResponseError("Invalid charger serial format");
  }
  return serial;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BASE_URL,
  DEFAULT_RATE_LIMIT_WAIT_MS,
  EaseeClient,
  HTTP_TIMEOUT_MS,
  SERIAL_PATTERN,
  TOKEN_MARGIN_MS,
  isAllowedRequest,
  isoSeconds
});
//# sourceMappingURL=easee-client.js.map
