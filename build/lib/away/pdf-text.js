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
var pdf_text_exports = {};
__export(pdf_text_exports, {
  MAX_PDF_BYTES: () => MAX_PDF_BYTES,
  ascii85: () => ascii85,
  parseCMap: () => parseCMap,
  pdfText: () => pdfText,
  winAnsi: () => winAnsi
});
module.exports = __toCommonJS(pdf_text_exports);
var import_node_zlib = require("node:zlib");
const MAX_PDF_BYTES = 2 * 1024 * 1024;
const MAX_STREAM_BYTES = 4 * 1024 * 1024;
const MAX_PIECES = 5e3;
const MAX_PAGES = 5;
function ascii85(input) {
  const s = input.replace(/\s+/g, "").replace(/^<~/, "").replace(/~>[\s\S]*$/, "");
  const out = [];
  let tuple = [];
  const flush = (count) => {
    let v = 0;
    for (const t of tuple) {
      v = v * 85 + t;
    }
    const bytes = [v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255];
    out.push(...bytes.slice(0, count));
  };
  for (const ch of s) {
    if (ch === "z" && tuple.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const code = ch.charCodeAt(0) - 33;
    if (code < 0 || code > 84) {
      throw new Error("ascii85: invalid character");
    }
    tuple.push(code);
    if (tuple.length === 5) {
      flush(4);
      tuple = [];
    }
    if (out.length > MAX_STREAM_BYTES) {
      throw new Error("ascii85: too large");
    }
  }
  if (tuple.length > 0) {
    const n = tuple.length;
    while (tuple.length < 5) {
      tuple.push(84);
    }
    flush(n - 1);
  }
  return Buffer.from(out);
}
function readObjects(s) {
  var _a;
  const objects = /* @__PURE__ */ new Map();
  for (const m of s.matchAll(/(\d+)\s+\d+\s+obj\b/g)) {
    const start = ((_a = m.index) != null ? _a : 0) + m[0].length;
    const end = s.indexOf("endobj", start);
    if (end < 0) {
      continue;
    }
    const body = s.slice(start, end);
    const si = body.search(/\bstream\r?\n/);
    if (si < 0) {
      objects.set(Number(m[1]), { dict: body, stream: void 0 });
      continue;
    }
    const dict = body.slice(0, si);
    let d = si + 6;
    if (body[d] === "\r") {
      d++;
    }
    if (body[d] === "\n") {
      d++;
    }
    const e = body.lastIndexOf("endstream");
    objects.set(Number(m[1]), { dict, stream: decodeStream(dict, body.slice(d, e < d ? body.length : e)) });
  }
  return objects;
}
function decodeStream(dict, raw) {
  var _a, _b;
  const filter = (_b = (_a = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict)) == null ? void 0 : _a[1]) != null ? _b : "";
  let data = Buffer.from(raw, "latin1");
  try {
    for (const f of [...filter.matchAll(/\/(\w+)/g)].map((x) => x[1])) {
      if (f === "ASCII85Decode" || f === "A85") {
        data = ascii85(data.toString("latin1"));
      } else if (f === "FlateDecode" || f === "Fl") {
        data = (0, import_node_zlib.inflateSync)(data, { maxOutputLength: MAX_STREAM_BYTES });
      } else {
        return null;
      }
    }
  } catch {
    return null;
  }
  return data;
}
function ref(text, key) {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(text);
  return m ? Number(m[1]) : void 0;
}
function inlineDict(text, key) {
  const i = text.search(new RegExp(`/${key}\\s*<<`));
  if (i < 0) {
    return void 0;
  }
  let depth = 0;
  for (let j = text.indexOf("<<", i); j < text.length - 1; j++) {
    if (text.startsWith("<<", j)) {
      depth++;
      j++;
    } else if (text.startsWith(">>", j)) {
      depth--;
      if (depth === 0) {
        return text.slice(text.indexOf("<<", i) + 2, j);
      }
      j++;
    }
  }
  return void 0;
}
function parseCMap(text) {
  const map = /* @__PURE__ */ new Map();
  const utf16 = (hex) => {
    const bytes = Buffer.from(hex.length % 2 ? `${hex}0` : hex, "hex");
    let out = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode(bytes[i] << 8 | bytes[i + 1]);
    }
    return out;
  };
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(p[1], 16), utf16(p[2]));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const from = parseInt(p[1], 16);
      const to = Math.min(parseInt(p[2], 16), from + 65535);
      let unicode = parseInt(p[3], 16);
      for (let c = from; c <= to; c++) {
        map.set(c, String.fromCodePoint(unicode++));
      }
    }
  }
  return map;
}
function tokenize(content, onOperator) {
  var _a, _b, _c, _d;
  let i = 0;
  let stack = [];
  const literal = () => {
    var _a2, _b2, _c2;
    const out = [];
    let depth = 1;
    i++;
    while (i < content.length && depth > 0) {
      const c = content[i];
      if (c === "\\") {
        const n = (_a2 = content[i + 1]) != null ? _a2 : "";
        const esc = { n: 10, r: 13, t: 9, b: 8, f: 12 };
        if (n in esc) {
          out.push(esc[n]);
          i += 2;
        } else if (/[0-7]/.test(n)) {
          const oct = (_c2 = (_b2 = /^[0-7]{1,3}/.exec(content.slice(i + 1, i + 4))) == null ? void 0 : _b2[0]) != null ? _c2 : "0";
          out.push(parseInt(oct, 8) & 255);
          i += 1 + oct.length;
        } else if (n === "\r" || n === "\n") {
          i += content[i + 1] === "\r" && content[i + 2] === "\n" ? 3 : 2;
        } else {
          out.push(n.charCodeAt(0) & 255);
          i += 2;
        }
        continue;
      }
      if (c === "(") {
        depth++;
      } else if (c === ")") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
      out.push(c.charCodeAt(0) & 255);
      i++;
    }
    return Buffer.from(out);
  };
  while (i < content.length) {
    const c = content[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "%") {
      while (i < content.length && content[i] !== "\n" && content[i] !== "\r") {
        i++;
      }
    } else if (c === "(") {
      stack.push({ kind: "str", bytes: literal() });
    } else if (c === "<" && content[i + 1] !== "<") {
      const end = content.indexOf(">", i);
      const hex = content.slice(i + 1, end < 0 ? content.length : end).replace(/[^0-9a-fA-F]/g, "");
      stack.push({ kind: "str", bytes: Buffer.from(hex.length % 2 ? `${hex}0` : hex, "hex") });
      i = end < 0 ? content.length : end + 1;
    } else if (c === "<" || c === ">") {
      stack.push({ kind: "other" });
      i += 2;
    } else if (c === "[") {
      stack.push({ kind: "open" });
      i++;
    } else if (c === "]") {
      const items = [];
      while (stack.length > 0 && stack[stack.length - 1].kind !== "open") {
        items.unshift(stack.pop());
      }
      stack.pop();
      stack.push({ kind: "arr", items });
      i++;
    } else if (c === "{" || c === "}" || c === ")") {
      i++;
    } else if (c === "/") {
      const m = (_b = (_a = /^\/[^\s/<>[\]()%{}]*/.exec(content.slice(i, i + 128))) == null ? void 0 : _a[0]) != null ? _b : "/";
      stack.push({ kind: "name", value: m.slice(1) });
      i += m.length;
    } else {
      const m = (_d = (_c = /^[^\s/<>[\]()%{}]+/.exec(content.slice(i, i + 128))) == null ? void 0 : _c[0]) != null ? _d : c;
      i += m.length;
      if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(m)) {
        stack.push({ kind: "num", value: Number(m) });
      } else {
        onOperator(m, stack);
        stack = [];
        if (m === "BI") {
          const end = content.indexOf("EI", i);
          i = end < 0 ? content.length : end + 2;
        }
      }
    }
  }
}
const WIN_ANSI = {
  128: "\u20AC",
  130: "\u201A",
  131: "\u0192",
  132: "\u201E",
  133: "\u2026",
  134: "\u2020",
  135: "\u2021",
  136: "\u02C6",
  137: "\u2030",
  138: "\u0160",
  139: "\u2039",
  140: "\u0152",
  142: "\u017D",
  145: "\u2018",
  146: "\u2019",
  147: "\u201C",
  148: "\u201D",
  149: "\u2022",
  150: "\u2013",
  151: "\u2014",
  152: "\u02DC",
  153: "\u2122",
  154: "\u0161",
  155: "\u203A",
  156: "\u0153",
  158: "\u017E",
  159: "\u0178"
};
function winAnsi(bytes) {
  return [...bytes].map((b) => {
    var _a;
    return (_a = WIN_ANSI[b]) != null ? _a : String.fromCharCode(b);
  }).join("");
}
function pdfText(pdf) {
  var _a, _b, _c, _d, _e;
  if (pdf.length > MAX_PDF_BYTES) {
    throw new Error("PDF too large");
  }
  const s = pdf.toString("latin1");
  if (!s.startsWith("%PDF-")) {
    throw new Error("not a PDF");
  }
  const objects = readObjects(s);
  const resolve = (text, key) => {
    var _a2;
    const inline = inlineDict(text, key);
    if (inline !== void 0) {
      return inline;
    }
    const n = ref(text, key);
    return n === void 0 ? void 0 : (_a2 = objects.get(n)) == null ? void 0 : _a2.dict;
  };
  const pieces = [];
  const pages = [...objects.values()].filter((o) => /\/Type\s*\/Page\b/.test(o.dict)).slice(0, MAX_PAGES);
  for (const page of pages) {
    const resources = (_a = resolve(page.dict, "Resources")) != null ? _a : "";
    const fontDict = (_b = resolve(resources, "Font")) != null ? _b : "";
    const fonts = /* @__PURE__ */ new Map();
    for (const f of fontDict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
      const font2 = objects.get(Number(f[2]));
      const toUnicode = font2 ? ref(font2.dict, "ToUnicode") : void 0;
      const cmap = toUnicode === void 0 ? void 0 : (_c = objects.get(toUnicode)) == null ? void 0 : _c.stream;
      fonts.set(f[1], cmap ? parseCMap(cmap.toString("latin1")) : null);
    }
    const contents = (_e = (_d = /\/Contents\s*\[([^\]]*)\]/.exec(page.dict)) == null ? void 0 : _d[1]) != null ? _e : page.dict;
    const streams = [...contents.matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => {
      var _a2;
      return (_a2 = objects.get(Number(m[1]))) == null ? void 0 : _a2.stream;
    }).filter((b) => !!b);
    let font = null;
    const decode = (bytes) => font ? [...bytes].map((b) => {
      var _a2;
      return (_a2 = font == null ? void 0 : font.get(b)) != null ? _a2 : "";
    }).join("") : winAnsi(bytes);
    for (const stream of streams) {
      tokenize(stream.toString("latin1"), (op, args) => {
        var _a2;
        if (pieces.length >= MAX_PIECES) {
          return;
        }
        const last = args[args.length - 1];
        if (op === "Tf") {
          const name = args.find((a) => a.kind === "name");
          font = (name == null ? void 0 : name.kind) === "name" ? (_a2 = fonts.get(name.value)) != null ? _a2 : null : null;
        } else if ((op === "Tj" || op === "'" || op === '"') && (last == null ? void 0 : last.kind) === "str") {
          pieces.push(decode(last.bytes));
        } else if (op === "TJ" && (last == null ? void 0 : last.kind) === "arr") {
          pieces.push(
            last.items.map(
              (t) => t.kind === "str" ? decode(t.bytes) : t.kind === "num" && t.value < -200 ? " " : ""
            ).join("")
          );
        }
      });
    }
  }
  return pieces.map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MAX_PDF_BYTES,
  ascii85,
  parseCMap,
  pdfText,
  winAnsi
});
//# sourceMappingURL=pdf-text.js.map
