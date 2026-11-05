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
var tankerkoenig_exports = {};
__export(tankerkoenig_exports, {
  API_KEY_PATTERN: () => API_KEY_PATTERN,
  BASE_URL: () => BASE_URL,
  DEFAULT_RATE_LIMIT_WAIT_MS: () => DEFAULT_RATE_LIMIT_WAIT_MS,
  HTTP_TIMEOUT_MS: () => HTTP_TIMEOUT_MS,
  MAX_RETRY_AFTER_MS: () => import_http2.MAX_RETRY_AFTER_MS,
  MAX_STATIONS_PER_REQUEST: () => MAX_STATIONS_PER_REQUEST,
  STATION_ID_PATTERN: () => STATION_ID_PATTERN,
  TankerkoenigClient: () => TankerkoenigClient,
  normalizeApiKey: () => normalizeApiKey,
  parsePrice: () => parsePrice,
  parseRetryAfter: () => import_http2.parseRetryAfter
});
module.exports = __toCommonJS(tankerkoenig_exports);
var import_errors = require("./errors");
var import_http = require("../util/http");
var import_http2 = require("../util/http");
const BASE_URL = "https://creativecommons.tankerkoenig.de/json";
const HTTP_TIMEOUT_MS = 1e4;
const MAX_STATIONS_PER_REQUEST = 10;
const DEFAULT_RATE_LIMIT_WAIT_MS = 15 * 6e4;
const STATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const API_KEY_PATTERN = STATION_ID_PATTERN;
function normalizeApiKey(key) {
  return typeof key === "string" ? key.replace(/[\u0000-\u001f\u007f\s]/g, "").toLowerCase() : "";
}
class TankerkoenigClient {
  /**
   * @param apiKey - Normalised API key
   * @param options - Optional settings
   */
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
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
  /**
   * Current prices of up to 10 stations (prices.php).
   *
   * @param stationIds - Station IDs (UUIDs)
   * @returns Map station ID (lower case) -> prices; stations the API does not mention are missing
   */
  async getPrices(stationIds) {
    const ids = stationIds.map(checkStationId);
    if (ids.length === 0 || ids.length > MAX_STATIONS_PER_REQUEST) {
      throw new import_errors.FuelResponseError(`prices.php needs 1-${MAX_STATIONS_PER_REQUEST} stations, got ${ids.length}`);
    }
    const body = await this.getJson("prices.php", { ids: ids.join(",") });
    const prices = body.prices;
    if (typeof prices !== "object" || prices === null || Array.isArray(prices)) {
      throw new import_errors.FuelResponseError("Unexpected answer of prices.php (no prices object)");
    }
    const result = /* @__PURE__ */ new Map();
    for (const [id, entry] of Object.entries(prices)) {
      if (!STATION_ID_PATTERN.test(id) || typeof entry !== "object" || entry === null) {
        continue;
      }
      const raw = entry;
      result.set(id.toLowerCase(), {
        status: typeof raw.status === "string" ? raw.status.slice(0, 40) : "unknown",
        e10: parsePrice(raw.e10)
      });
    }
    return result;
  }
  /**
   * Master data of one station (detail.php). Use rarely (at most daily).
   *
   * @param stationId - Station ID (UUID)
   */
  async getDetail(stationId) {
    const body = await this.getJson("detail.php", { id: checkStationId(stationId) });
    const station = body.station;
    if (typeof station !== "object" || station === null) {
      throw new import_errors.FuelResponseError("Unexpected answer of detail.php (no station object)");
    }
    const raw = station;
    return {
      name: text(raw.name),
      brand: text(raw.brand),
      street: text(raw.street),
      houseNumber: text(raw.houseNumber),
      postCode: text(raw.postCode),
      place: text(raw.place),
      isOpen: typeof raw.isOpen === "boolean" ? raw.isOpen : null,
      wholeDay: typeof raw.wholeDay === "boolean" ? raw.wholeDay : null
    };
  }
  /** Cancels running requests (adapter unload) */
  abort() {
    this.shutdown.abort();
  }
  /**
   * GET with key, timeout and error mapping. The URL contains the key and is never logged.
   *
   * @param file - prices.php / detail.php
   * @param params - Query parameters without the key
   */
  async getJson(file, params) {
    var _a, _b;
    const query = new URLSearchParams({ ...params, apikey: this.apiKey });
    let response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/${file}?${query.toString()}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(this.timeoutMs)])
      });
    } catch (error) {
      if (this.shutdown.signal.aborted) {
        throw new import_errors.FuelAbortedError("Request aborted (shutdown)");
      }
      throw new import_errors.FuelNetworkError(`${file}: no answer (${(0, import_http.networkReason)(error)})`);
    }
    if (response.status === 429) {
      await ((_a = response.body) == null ? void 0 : _a.cancel().catch(() => void 0));
      const waitMs = (_b = (0, import_http.parseRetryAfter)(response.headers.get("retry-after"), this.now())) != null ? _b : DEFAULT_RATE_LIMIT_WAIT_MS;
      throw new import_errors.FuelRateLimitedError(`${file}: too many requests (HTTP 429)`, waitMs);
    }
    const textBody = await response.text().catch(() => "");
    let body;
    try {
      body = JSON.parse(textBody);
    } catch {
      throw new import_errors.FuelResponseError(`${file}: HTTP ${response.status}, answer is not JSON`, response.status);
    }
    const ok = body == null ? void 0 : body.ok;
    const message = shortMessage(body == null ? void 0 : body.message);
    if (response.status === 401 || response.status === 403 || ok === false && /(api-?key|\bkey\b)/i.test(message)) {
      throw new import_errors.FuelKeyRejectedError(`${file}: API key rejected (${message || `HTTP ${response.status}`})`);
    }
    if (ok === false && /(too many|zu viele|rate)/i.test(message)) {
      throw new import_errors.FuelRateLimitedError(`${file}: too many requests (${message})`, DEFAULT_RATE_LIMIT_WAIT_MS);
    }
    if (ok === false) {
      throw new import_errors.FuelRefusedError(
        `${file}: request refused (${message || `HTTP ${response.status}`})`,
        response.status
      );
    }
    if (!response.ok || ok !== true) {
      throw new import_errors.FuelResponseError(
        `${file}: HTTP ${response.status}${message ? ` (${message})` : ""}`,
        response.status
      );
    }
    return body;
  }
}
function checkStationId(id) {
  if (!STATION_ID_PATTERN.test(id)) {
    throw new import_errors.FuelResponseError("Invalid station ID format (expected UUID)");
  }
  return id.toLowerCase();
}
function parsePrice(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0.3 || value > 5) {
    return null;
  }
  return Math.round(value * 1e3) / 1e3;
}
function text(value) {
  return typeof value === "string" ? value.trim().slice(0, 100) : "";
}
function shortMessage(value) {
  return typeof value === "string" ? value.slice(0, 200) : "";
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  API_KEY_PATTERN,
  BASE_URL,
  DEFAULT_RATE_LIMIT_WAIT_MS,
  HTTP_TIMEOUT_MS,
  MAX_RETRY_AFTER_MS,
  MAX_STATIONS_PER_REQUEST,
  STATION_ID_PATTERN,
  TankerkoenigClient,
  normalizeApiKey,
  parsePrice,
  parseRetryAfter
});
//# sourceMappingURL=tankerkoenig.js.map
