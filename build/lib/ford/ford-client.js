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
var ford_client_exports = {};
__export(ford_client_exports, {
  AUTHORIZE_PATH: () => AUTHORIZE_PATH,
  B2C_SHARED_ACCESS_ERROR: () => B2C_SHARED_ACCESS_ERROR,
  BASE_URL: () => BASE_URL,
  DEFAULT_RATE_LIMIT_WAIT_MS: () => DEFAULT_RATE_LIMIT_WAIT_MS,
  FordClient: () => FordClient,
  HTTP_TIMEOUT_MS: () => HTTP_TIMEOUT_MS,
  LOGIN_LIFETIME_MS: () => LOGIN_LIFETIME_MS,
  QUERY_PATH: () => QUERY_PATH,
  TOKEN_MARGIN_MS: () => TOKEN_MARGIN_MS,
  TOKEN_PATH: () => TOKEN_PATH,
  authTimeFromIdToken: () => authTimeFromIdToken,
  b2cErrorCode: () => b2cErrorCode,
  buildAuthorizeUrl: () => buildAuthorizeUrl,
  parseRedirect: () => parseRedirect
});
module.exports = __toCommonJS(ford_client_exports);
var import_errors = require("./errors");
var import_http = require("../util/http");
const BASE_URL = "https://api.vehicle.ford.com";
const AUTHORIZE_PATH = "/fcon-public/v1/auth/init";
const TOKEN_PATH = "/dah2vb2cprod.onmicrosoft.com/oauth2/v2.0/token?p=B2C_1A_FCON_AUTHORIZE";
const QUERY_PATH = "/fcon-query/v1";
const HTTP_TIMEOUT_MS = 45e3;
const TOKEN_MARGIN_MS = 2 * 6e4;
const DEFAULT_RATE_LIMIT_WAIT_MS = 62e3;
const LOGIN_LIFETIME_MS = 365 * 24 * 36e5;
function buildAuthorizeUrl(clientId, redirectUri, state, baseUrl = BASE_URL) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state: state.slice(0, 16)
  });
  return `${baseUrl}${AUTHORIZE_PATH}?${query.toString()}`;
}
function parseRedirect(text) {
  var _a, _b;
  const trimmed = text.trim();
  const query = trimmed.includes("?") ? trimmed.slice(trimmed.indexOf("?") + 1) : trimmed;
  if (query.includes("=")) {
    const params = new URLSearchParams(query.split("#")[0]);
    return {
      code: (_a = params.get("code")) != null ? _a : "",
      state: params.get("state"),
      error: (_b = params.get("error_description")) != null ? _b : params.get("error")
    };
  }
  return { code: trimmed, state: null, error: null };
}
const B2C_SHARED_ACCESS_ERROR = "AADB2C90085";
function b2cErrorCode(text) {
  const match = /AADB2C\d{5}/.exec(text != null ? text : "");
  return match ? match[0] : null;
}
function authTimeFromIdToken(idToken) {
  if (typeof idToken !== "string") {
    return null;
  }
  const part = idToken.split(".")[1];
  if (!part) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof payload.auth_time === "number" ? payload.auth_time * 1e3 : null;
  } catch {
    return null;
  }
}
class FordClient {
  /**
   * @param clientId - App client ID
   * @param clientSecret - App client secret
   * @param redirectUri - Redirect URI registered in the portal
   * @param store - Token storage of this vehicle
   * @param options - Optional settings
   */
  constructor(clientId, clientSecret, redirectUri, store, options = {}) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.store = store;
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
  loaded = false;
  pending;
  /** A token is stored (the user has logged in at least once) */
  async hasLogin() {
    await this.loadToken();
    return this.token !== void 0;
  }
  /** Time of the browser login, null if unknown */
  authTime() {
    var _a, _b;
    return (_b = (_a = this.token) == null ? void 0 : _a.authTime) != null ? _b : null;
  }
  /**
   * Exchanges the code from the browser login for tokens.
   *
   * @param code - Authorization code
   */
  async login(code) {
    const body = await this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri
    });
    this.token = this.parseToken(body, "", null);
    await this.store.save(this.token);
  }
  /** Forgets the stored login (after a rejected refresh token) */
  async forgetLogin() {
    this.token = void 0;
    await this.store.save(void 0);
  }
  /** Vehicle of this login */
  async getGarage() {
    const body = await this.get("/garage", "garage");
    const raw = body != null ? body : {};
    const text = (value) => typeof value === "string" ? value.trim().slice(0, 60) : "";
    return {
      vehicleType: text(raw.vehicleType) || text(raw.modelName),
      engineType: text(raw.engineType),
      color: text(raw.color)
    };
  }
  /** Telemetry (metrics) of the vehicle */
  async getTelemetry() {
    const body = await this.get("/telemetry", "telemetry");
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new import_errors.FordResponseError("telemetry: unexpected answer");
    }
    return body;
  }
  /** Cancels running requests */
  abort() {
    this.shutdown.abort();
  }
  async loadToken() {
    if (!this.loaded) {
      this.loaded = true;
      this.token = await this.store.load();
    }
  }
  /**
   * GET on the query API with a valid token; one retry with a fresh token after 401.
   *
   * @param path - Path below /fcon-query/v1
   * @param label - Name for messages
   */
  async get(path, label) {
    var _a;
    for (let attempt = 0; ; attempt++) {
      const token = await this.validToken();
      const response = await this.send(`${QUERY_PATH}${path}`, label, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${token.access}` }
      });
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
  async validToken() {
    var _a;
    await this.loadToken();
    if (!this.token) {
      throw new import_errors.FordLoginRequiredError("no login yet");
    }
    if (this.token.expiresAt - TOKEN_MARGIN_MS > this.now()) {
      return this.token;
    }
    (_a = this.pending) != null ? _a : this.pending = this.refresh().finally(() => {
      this.pending = void 0;
    });
    return this.pending;
  }
  async refresh() {
    const old = this.token;
    if (!(old == null ? void 0 : old.refresh)) {
      throw new import_errors.FordLoginRequiredError("no refresh token");
    }
    const body = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: old.refresh });
    this.token = this.parseToken(body, old.refresh, old.authTime);
    await this.store.save(this.token);
    return this.token;
  }
  /**
   * POST to the token endpoint (form encoded, client credentials in the body).
   *
   * @param params - Grant parameters
   */
  async tokenRequest(params) {
    var _a;
    const form = new URLSearchParams({ ...params, client_id: this.clientId, client_secret: this.clientSecret });
    const label = params.grant_type === "refresh_token" ? "token refresh" : "login";
    const response = await this.send(TOKEN_PATH, label, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString()
    });
    if (response.status === 429) {
      await ((_a = response.body) == null ? void 0 : _a.cancel().catch(() => void 0));
      throw this.rateLimited(response, label);
    }
    const text = await response.text().catch(() => "");
    if (response.ok) {
      try {
        return JSON.parse(text);
      } catch {
        throw new import_errors.FordResponseError(`${label}: answer is not JSON`, response.status);
      }
    }
    const error = oauthError(text);
    const b2c = b2cErrorCode(text);
    if (error === "invalid_client" || error === "unauthorized_client") {
      throw new import_errors.FordClientRejectedError(`${label}: client ID/secret rejected (${error})`, response.status);
    }
    if (response.status === 400 || response.status === 401) {
      const reason = [error || `HTTP ${response.status}`, b2c].filter(Boolean).join(", ");
      throw new import_errors.FordLoginRequiredError(`${label}: rejected (${reason})`);
    }
    throw new import_errors.FordResponseError(`${label}: HTTP ${response.status}`, response.status);
  }
  /**
   * @param body - Token answer
   * @param previousRefresh - Kept when the answer has no refresh token
   * @param previousAuthTime - Kept when the answer has no id_token
   */
  parseToken(body, previousRefresh, previousAuthTime) {
    var _a, _b;
    const raw = body != null ? body : {};
    if (typeof raw.access_token !== "string" || raw.access_token === "") {
      throw new import_errors.FordResponseError("token: unexpected answer (no access token)");
    }
    const expiresIn = Number(raw.expires_in);
    return {
      access: raw.access_token,
      refresh: typeof raw.refresh_token === "string" && raw.refresh_token ? raw.refresh_token : previousRefresh,
      expiresAt: this.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 1200) * 1e3,
      authTime: (_b = (_a = authTimeFromIdToken(raw.id_token)) != null ? _a : previousAuthTime) != null ? _b : previousRefresh ? null : this.now()
    };
  }
  /**
   * @param path - Path incl. query
   * @param label - Name for messages
   * @param init - Request
   */
  async send(path, label, init) {
    try {
      return await this.fetchFn(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(this.timeoutMs)])
      });
    } catch (error) {
      if (this.shutdown.signal.aborted) {
        throw new import_errors.FordAbortedError("Request aborted (shutdown)");
      }
      throw new import_errors.FordNetworkError(`${label}: no answer (${(0, import_http.networkReason)(error)})`);
    }
  }
  /**
   * @param response - Answer
   * @param label - Name for messages
   */
  async readJson(response, label) {
    var _a;
    if (response.status === 429) {
      await ((_a = response.body) == null ? void 0 : _a.cancel().catch(() => void 0));
      throw this.rateLimited(response, label);
    }
    const text = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw new import_errors.FordLoginRequiredError(`${label}: access denied (HTTP ${response.status})`);
    }
    if (!response.ok) {
      throw new import_errors.FordResponseError(`${label}: HTTP ${response.status}`, response.status);
    }
    if (text.trim() === "") {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new import_errors.FordResponseError(`${label}: answer is not JSON`, response.status);
    }
  }
  /**
   * @param response - 429 answer
   * @param label - Name for messages
   */
  rateLimited(response, label) {
    var _a;
    const waitMs = (_a = (0, import_http.parseRetryAfter)(response.headers.get("retry-after"), this.now())) != null ? _a : DEFAULT_RATE_LIMIT_WAIT_MS;
    return new import_errors.FordRateLimitedError(`${label}: too many requests (HTTP 429)`, waitMs);
  }
}
function oauthError(text) {
  try {
    const error = JSON.parse(text).error;
    return typeof error === "string" ? error.replace(/[^a-z_]/gi, "").slice(0, 40) : "";
  } catch {
    return "";
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AUTHORIZE_PATH,
  B2C_SHARED_ACCESS_ERROR,
  BASE_URL,
  DEFAULT_RATE_LIMIT_WAIT_MS,
  FordClient,
  HTTP_TIMEOUT_MS,
  LOGIN_LIFETIME_MS,
  QUERY_PATH,
  TOKEN_MARGIN_MS,
  TOKEN_PATH,
  authTimeFromIdToken,
  b2cErrorCode,
  buildAuthorizeUrl,
  parseRedirect
});
//# sourceMappingURL=ford-client.js.map
