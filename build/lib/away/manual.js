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
var manual_exports = {};
__export(manual_exports, {
  parseManual: () => parseManual
});
module.exports = __toCommonJS(manual_exports);
const DAY_MS = 864e5;
function number(s) {
  return Number(s.replace(",", "."));
}
function parseManual(message, now) {
  const body = message.replace(/^\[[^\]]*\]/, "").trim();
  const m = /^laden(?:\s+|$)([\s\S]*)$/i.exec(body);
  if (!m) {
    const plain = parseParts(body, now);
    return plain.kind === "add" ? plain : null;
  }
  if (/^\s*(löschen|loeschen)\s*$/i.test(m[1])) {
    return { kind: "delete" };
  }
  return parseParts(m[1], now);
}
function parseParts(text, now) {
  let rest = ` ${text.trim()} `;
  const take = (re) => {
    const found = re.exec(rest);
    if (found) {
      rest = `${rest.slice(0, found.index)} ${rest.slice(found.index + found[0].length)}`;
    }
    return found;
  };
  const kwhMatch = take(/(?<=\s)(\d{1,3}(?:[.,]\d{1,3})?)\s*kwh(?=\s)/i);
  const costMatch = take(/(?<=\s)(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:€|eur|euro)(?=\s)/i);
  const dateMatch = take(/(?<=\s)(\d{1,2})\.(\d{1,2})(?:\.(\d{4}|\d{2})?)?(?=\s)/);
  const wordMatch = dateMatch ? null : take(/(?<=\s)(heute|gestern)(?=\s)/i);
  if (rest.trim()) {
    return { kind: "invalid", reason: `"${rest.trim()}" not understood` };
  }
  if (!kwhMatch) {
    return { kind: "invalid", reason: "kWh missing" };
  }
  const kwh = number(kwhMatch[1]);
  if (!(kwh > 0 && kwh <= 200)) {
    return { kind: "invalid", reason: "kWh out of range (0-200)" };
  }
  const cost = costMatch ? number(costMatch[1]) : 0;
  if (!(cost >= 0 && cost <= 500)) {
    return { kind: "invalid", reason: "amount out of range" };
  }
  let time = now;
  if (dateMatch) {
    const today = new Date(now);
    const day = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const y = dateMatch[3];
    let year = y ? y.length === 2 ? 2e3 + Number(y) : Number(y) : today.getFullYear();
    let date = new Date(year, month - 1, day, 12);
    if (!y && date.getTime() > now) {
      year--;
      date = new Date(year, month - 1, day, 12);
    }
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return { kind: "invalid", reason: "date not valid" };
    }
    if (date.getTime() > now + DAY_MS) {
      return { kind: "invalid", reason: "date in the future" };
    }
    time = date.getTime();
  } else if (wordMatch && wordMatch[1].toLowerCase() === "gestern") {
    const d = new Date(now - DAY_MS);
    time = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime();
  }
  return { kind: "add", kwh: Math.round(kwh * 100) / 100, cost: Math.round(cost * 100) / 100, time };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  parseManual
});
//# sourceMappingURL=manual.js.map
