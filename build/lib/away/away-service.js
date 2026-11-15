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
var away_service_exports = {};
__export(away_service_exports, {
  AWAY_ROOT: () => AWAY_ROOT,
  AwayService: () => AwayService,
  awayObjects: () => awayObjects,
  describeReceipt: () => describeReceipt,
  parseStore: () => parseStore
});
module.exports = __toCommonJS(away_service_exports);
var import_objects = require("../easee/objects");
var import_sessions_sync = require("../easee/sessions-sync");
var import_sessions = require("../easee/sessions");
const AWAY_ROOT = "away";
const REFRESH_MS = 36e5;
function awayObjects() {
  return [
    {
      id: AWAY_ROOT,
      obj: {
        type: "device",
        common: { name: { en: "Charging on the road", de: "Laden unterwegs" } },
        native: {}
      }
    },
    {
      id: `${AWAY_ROOT}.lastReceipt`,
      obj: {
        type: "state",
        common: {
          name: { en: "Last receipt taken over", de: "Zuletzt \xFCbernommener Beleg" },
          type: "string",
          role: "text",
          read: true,
          write: false
        },
        native: {}
      }
    },
    // easee.history has the same states; lastSync only exists per charger
    ...(0, import_objects.historyObjects)(AWAY_ROOT, true).filter((d) => !d.id.endsWith(".lastSync"))
  ];
}
function parseStore(text) {
  try {
    const data = text ? JSON.parse(text) : {};
    const list = data == null ? void 0 : data.receipts;
    if (!Array.isArray(list)) {
      return [];
    }
    return list.filter(
      (r) => !!r && typeof r === "object" && Number.isSafeInteger(r.id) && typeof r.start === "number" && typeof r.end === "number" && typeof r.kwh === "number" && typeof r.paid === "number"
    );
  } catch {
    return [];
  }
}
function asSession(r) {
  return {
    id: r.id,
    start: r.start,
    end: r.end,
    kwh: r.kwh,
    seconds: Math.round((r.end - r.start) / 1e3),
    easeeCost: r.paid,
    complete: true
  };
}
function describeReceipt(r, german) {
  const locale = german ? "de-DE" : "en-GB";
  const d = new Date(r.start);
  const date = d.toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "numeric" });
  const time = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const num = (v) => v.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return [`${date} ${time}`, r.provider, `${num(r.kwh)} kWh`, `${num(r.paid)} \u20AC`].filter(Boolean).join(" \xB7 ");
}
class AwayService {
  /**
   * @param deps - Adapter functions
   * @param german - German texts
   */
  constructor(deps, german) {
    this.deps = deps;
    this.german = german;
  }
  receipts = [];
  /** Pending update (wrapped: TimerHandle is unknown) */
  timer;
  stopped = false;
  /** writes one after the other */
  chain = Promise.resolve();
  /** Creates the objects, reads the file and writes the evaluation */
  async start() {
    await this.deps.ensureObjects(awayObjects());
    this.receipts = parseStore(await this.deps.load().catch(() => void 0));
    await this.writeReport();
    this.schedule();
  }
  /** Stops the hourly update */
  stop() {
    this.stopped = true;
    if (this.timer !== void 0) {
      this.deps.clearTimeout(this.timer.handle);
      this.timer = void 0;
    }
  }
  /** Number of stored receipts */
  get count() {
    return this.receipts.length;
  }
  /**
   * Takes over a receipt.
   *
   * @param receipt - Receipt read from a PDF
   * @returns added, or duplicate if the receipt number is already known
   */
  add(receipt) {
    const run = this.chain.then(async () => {
      if (this.receipts.some((r) => r.id === receipt.id)) {
        return "duplicate";
      }
      const next = [...this.receipts, receipt].sort((a, b) => a.start - b.start);
      await this.deps.save(JSON.stringify({ version: 1, receipts: next }));
      this.receipts = next;
      await this.writeReport();
      await this.deps.setState(`${AWAY_ROOT}.lastReceipt`, describeReceipt(receipt, this.german));
      return "added";
    });
    this.chain = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
  schedule() {
    if (this.stopped) {
      return;
    }
    const handle = this.deps.setTimeout(() => {
      this.timer = void 0;
      this.chain = this.chain.then(() => this.writeReport()).catch((error) => this.deps.log.warn(`Charging on the road: ${error.message}`));
      this.schedule();
    }, REFRESH_MS);
    this.timer = { handle };
  }
  async writeReport() {
    var _a, _b;
    const now = this.deps.now();
    const report = new import_sessions.SessionReport(this.receipts.map(asSession), 0);
    const p = `${AWAY_ROOT}.history`;
    const months = report.months(now, import_sessions_sync.MONTHS);
    const month = months[months.length - 1];
    const year = report.year(new Date(now).getFullYear());
    await this.deps.setState(`${p}.days`, JSON.stringify(report.days(now, import_sessions_sync.DAYS)));
    await this.deps.setState(`${p}.weeks`, JSON.stringify(report.weeks(now, import_sessions_sync.WEEKS)));
    await this.deps.setState(`${p}.months`, JSON.stringify(months));
    await this.deps.setState(`${p}.monthEnergy`, month.kwh);
    await this.deps.setState(`${p}.yearEnergy`, year.kwh);
    await this.deps.setState(`${p}.monthCost`, (_a = month.cost) != null ? _a : 0);
    await this.deps.setState(`${p}.yearCost`, (_b = year.cost) != null ? _b : 0);
    const last = report.last();
    await this.deps.setState(`${p}.lastSession`, last ? JSON.stringify(last) : null);
    await this.deps.setState(`${p}.oldestSession`, report.oldest());
    await this.deps.setState(`${p}.sessionCount`, this.receipts.length);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AWAY_ROOT,
  AwayService,
  awayObjects,
  describeReceipt,
  parseStore
});
//# sourceMappingURL=away-service.js.map
