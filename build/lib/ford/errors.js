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
  FordAbortedError: () => FordAbortedError,
  FordApiError: () => FordApiError,
  FordClientRejectedError: () => FordClientRejectedError,
  FordLoginRequiredError: () => FordLoginRequiredError,
  FordNetworkError: () => FordNetworkError,
  FordRateLimitedError: () => FordRateLimitedError,
  FordResponseError: () => FordResponseError
});
module.exports = __toCommonJS(errors_exports);
class FordApiError extends Error {
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
class FordNetworkError extends FordApiError {
}
class FordLoginRequiredError extends FordApiError {
}
class FordClientRejectedError extends FordApiError {
}
class FordRateLimitedError extends FordApiError {
  /**
   * @param message - Message
   * @param waitMs - Pause before the next request
   */
  constructor(message, waitMs) {
    super(message, 429);
    this.waitMs = waitMs;
  }
}
class FordResponseError extends FordApiError {
}
class FordAbortedError extends FordApiError {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  FordAbortedError,
  FordApiError,
  FordClientRejectedError,
  FordLoginRequiredError,
  FordNetworkError,
  FordRateLimitedError,
  FordResponseError
});
//# sourceMappingURL=errors.js.map
