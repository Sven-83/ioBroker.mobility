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
var errors_exports = {};
__export(errors_exports, {
  EaseeAbortedError: () => EaseeAbortedError,
  EaseeApiError: () => EaseeApiError,
  EaseeAuthError: () => EaseeAuthError,
  EaseeNetworkError: () => EaseeNetworkError,
  EaseeRateLimitedError: () => EaseeRateLimitedError,
  EaseeResponseError: () => EaseeResponseError
});
module.exports = __toCommonJS(errors_exports);
class EaseeApiError extends Error {
  /**
   * @param message - Message without secrets
   * @param status - HTTP status, if there was an answer
   */
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = new.target.name;
  }
}
class EaseeNetworkError extends EaseeApiError {
}
class EaseeAuthError extends EaseeApiError {
}
class EaseeRateLimitedError extends EaseeApiError {
  /**
   * @param message - Message
   * @param waitMs - Pause before the next request
   */
  constructor(message, waitMs) {
    super(message, 429);
    this.waitMs = waitMs;
  }
}
class EaseeResponseError extends EaseeApiError {
}
class EaseeAbortedError extends EaseeApiError {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  EaseeAbortedError,
  EaseeApiError,
  EaseeAuthError,
  EaseeNetworkError,
  EaseeRateLimitedError,
  EaseeResponseError
});
//# sourceMappingURL=errors.js.map
