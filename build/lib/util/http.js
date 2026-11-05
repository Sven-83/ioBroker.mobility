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
var http_exports = {};
__export(http_exports, {
  MAX_RETRY_AFTER_MS: () => MAX_RETRY_AFTER_MS,
  networkReason: () => networkReason,
  parseRetryAfter: () => parseRetryAfter
});
module.exports = __toCommonJS(http_exports);
const MAX_RETRY_AFTER_MS = 36e5;
function parseRetryAfter(header, now) {
  const value = header == null ? void 0 : header.trim();
  if (!value) {
    return void 0;
  }
  const ms = /^\d+$/.test(value) ? Number(value) * 1e3 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS) : void 0;
}
function networkReason(error) {
  const cause = error == null ? void 0 : error.cause;
  if (cause && typeof cause.code === "string") {
    return cause.code;
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return "timeout";
  }
  return (error instanceof Error ? error.message : String(error)).replace(/https?:\/\/\S+/g, "<url>");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MAX_RETRY_AFTER_MS,
  networkReason,
  parseRetryAfter
});
//# sourceMappingURL=http.js.map
