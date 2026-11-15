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
var receipt_exports = {};
__export(receipt_exports, {
  decimal: () => decimal,
  money: () => money,
  parseReceipt: () => parseReceipt,
  receiptTime: () => receiptTime,
  rowTime: () => rowTime
});
module.exports = __toCommonJS(receipt_exports);
const MONTHS = {
  jan: 1,
  feb: 2,
  m\u00E4r: 3,
  mar: 3,
  mrz: 3,
  apr: 4,
  mai: 5,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  okt: 10,
  oct: 10,
  nov: 11,
  dez: 12,
  dec: 12
};
const MAX_SESSION_MS = 48 * 36e5;
function money(s) {
  var _a;
  const m = /^(-?)\s*(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d+))?\s*(?:€|EUR)$/.exec((s != null ? s : "").trim());
  if (!m) {
    return null;
  }
  const value = Number(`${m[2].replace(/\./g, "")}.${(_a = m[3]) != null ? _a : "0"}`);
  return m[1] ? -value : value;
}
function decimal(s) {
  var _a;
  const m = /^(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d+))?$/.exec((s != null ? s : "").trim());
  return m ? Number(`${m[1].replace(/\./g, "")}.${(_a = m[2]) != null ? _a : "0"}`) : null;
}
function receiptTime(s) {
  var _a;
  const m = /^(\d{1,2})(?:st|nd|rd|th)?\.?\s+([A-Za-zÄÖÜäöü]{3,})\.?\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(
    (s != null ? s : "").trim()
  );
  const month = m ? MONTHS[m[2].slice(0, 3).toLowerCase()] : void 0;
  if (!m || !month) {
    return null;
  }
  return checkedDate(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number((_a = m[6]) != null ? _a : 0));
}
function rowTime(s) {
  const m = /^(\d{1,2}):(\d{2})\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec((s != null ? s : "").trim());
  if (!m) {
    return null;
  }
  const year = m[5].length === 2 ? 2e3 + Number(m[5]) : Number(m[5]);
  return checkedDate(year, Number(m[4]), Number(m[3]), Number(m[1]), Number(m[2]), 0);
}
function checkedDate(y, mo, d, h, mi, s) {
  const date = new Date(y, mo - 1, d, h, mi, s);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d && h < 24 && mi < 60 ? date.getTime() : null;
}
function parseReceipt(pieces) {
  var _a, _b, _c;
  const isElectroverse = pieces.some((p) => /electroverse/i.test(p));
  const after = (label, offset = 1) => {
    const i = pieces.findIndex((p) => label.test(p));
    return i < 0 ? void 0 : pieces[i + offset];
  };
  const kwhRow = pieces.findIndex((p) => /^Verbrauch\s*\[kWh\]$/i.test(p));
  if (!isElectroverse || kwhRow < 0) {
    return { ok: false, kind: "foreign", reason: "no Electroverse charging receipt" };
  }
  const broken = (reason) => ({ ok: false, kind: "broken", reason });
  const id = Number(after(/^Beleg$/));
  if (!Number.isSafeInteger(id) || id <= 0) {
    return broken("receipt number missing");
  }
  const start = (_a = receiptTime(after(/^Start des Ladevorgangs$/))) != null ? _a : rowTime(pieces[kwhRow - 2]);
  const end = (_b = receiptTime(after(/^Ende des Ladevorgangs$/))) != null ? _b : rowTime(pieces[kwhRow - 1]);
  if (start === null || end === null || end < start || end - start > MAX_SESSION_MS) {
    return broken("start or end missing");
  }
  const kwh = decimal(pieces[kwhRow + 2]);
  if (kwh === null || kwh <= 0 || kwh > 500) {
    return broken("energy missing");
  }
  const paid = money(after(/^Zu zahlender Betrag$/));
  if (paid === null || paid < 0 || paid > 2e3) {
    return broken("amount missing");
  }
  const discountGross = money(after(/^Rabatt$/, 3));
  const provider = ((_c = after(/^Anbieter$/)) != null ? _c : "").slice(0, 60);
  return {
    ok: true,
    receipt: {
      id,
      start,
      end,
      kwh: Math.round(kwh * 100) / 100,
      paid: Math.round(paid * 100) / 100,
      discount: discountGross === null ? 0 : Math.round(Math.abs(discountGross) * 100) / 100,
      pricePerKwh: money(pieces[kwhRow + 1]),
      provider: /^(Adresse|Start des Ladevorgangs)$/.test(provider) ? "" : provider
    }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  decimal,
  money,
  parseReceipt,
  receiptTime,
  rowTime
});
//# sourceMappingURL=receipt.js.map
