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
var receipt_intake_exports = {};
__export(receipt_intake_exports, {
  ReceiptIntake: () => ReceiptIntake,
  parseUsers: () => parseUsers
});
module.exports = __toCommonJS(receipt_intake_exports);
var import_pdf_text = require("./pdf-text");
var import_receipt = require("./receipt");
var import_away_service = require("./away-service");
function parseUsers(value) {
  try {
    const data = typeof value === "string" && value ? JSON.parse(value) : {};
    return new Set(data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data) : []);
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
class ReceiptIntake {
  /**
   * @param deps - Adapter functions
   * @param german - German answers
   */
  constructor(deps, german) {
    this.deps = deps;
    this.german = german;
  }
  /** one file after the other */
  chain = Promise.resolve();
  /**
   * The telegram adapter has saved a file.
   *
   * @param path - Value of communicate.pathFile
   */
  handle(path) {
    const run = this.chain.then(() => this.process(path));
    this.chain = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
  async process(path) {
    const g = this.german;
    if (!/\.pdf$/i.test(path)) {
      return "ignored";
    }
    const sender = await this.deps.senderId();
    if (!sender || !(await this.deps.knownUsers()).has(sender)) {
      this.deps.warn("Charging on the road: PDF from a Telegram user the bot does not know - ignored");
      return "unknownSender";
    }
    const chat = await this.deps.chatId();
    let result;
    try {
      result = (0, import_receipt.parseReceipt)((0, import_pdf_text.pdfText)(await this.deps.readFile(path)));
    } catch (error) {
      this.deps.warn(`Charging on the road: PDF not readable (${error.message})`);
      return "error";
    }
    if (!result.ok) {
      if (result.kind === "foreign") {
        return "foreign";
      }
      if (result.kind === "other") {
        await this.answer(
          chat,
          g ? "\u2139\uFE0F Electroverse-PDF, aber weder Ladebeleg noch Abo-Rechnung \u2013 nicht gez\xE4hlt." : "\u2139\uFE0F Electroverse PDF, but neither a charging receipt nor a subscription invoice - not counted."
        );
        return "foreign";
      }
      this.deps.warn(`Charging on the road: receipt not understood (${result.reason})`);
      await this.answer(
        chat,
        g ? `\u2753 Electroverse-Beleg erkannt, aber nicht vollst\xE4ndig lesbar (${result.reason}). Nichts \xFCbernommen.` : `\u2753 Electroverse receipt found, but not fully readable (${result.reason}). Nothing taken over.`
      );
      return "broken";
    }
    const text = (0, import_away_service.describeReceipt)(result.receipt, g);
    const outcome = await this.deps.add(result.receipt);
    await this.deps.deleteFile(path).catch(
      (error) => this.deps.warn(`Charging on the road: stored PDF not deleted (${error.message})`)
    );
    if (outcome === "duplicate") {
      await this.answer(chat, g ? `\u{1F9FE} Beleg war schon da: ${text}` : `\u{1F9FE} Receipt already known: ${text}`);
      return "duplicate";
    }
    const discount = result.receipt.discount > 0 ? g ? ` (${result.receipt.discount.toLocaleString("de-DE", { minimumFractionDigits: 2 })} \u20AC Rabatt)` : ` (${result.receipt.discount.toFixed(2)} \u20AC discount)` : "";
    this.deps.info(`Charging on the road: receipt taken over: ${text}`);
    const what = result.receipt.kind === "subscription" ? g ? "Abo-Rechnung \xFCbernommen" : "Subscription invoice taken over" : g ? "Beleg \xFCbernommen" : "Receipt taken over";
    await this.answer(chat, `\u{1F9FE} ${what}: ${text}${discount}`);
    return "added";
  }
  async answer(chat, text) {
    try {
      await this.deps.reply(chat, text);
    } catch (error) {
      this.deps.warn(`Charging on the road: answer not sent (${error.message})`);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ReceiptIntake,
  parseUsers
});
//# sourceMappingURL=receipt-intake.js.map
