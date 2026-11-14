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
var rating_exports = {};
__export(rating_exports, {
  CHEAP_SHARE: () => CHEAP_SHARE,
  MIN_COVERAGE_MS: () => MIN_COVERAGE_MS,
  MIN_WEEKDAY_COVERAGE_MS: () => MIN_WEEKDAY_COVERAGE_MS,
  chartPoints: () => chartPoints,
  evaluate: () => evaluate,
  segments: () => segments
});
module.exports = __toCommonJS(rating_exports);
var import_price_history = require("./price-history");
const CHEAP_SHARE = 0.25;
const MIN_COVERAGE_MS = 24 * 36e5;
const MIN_WEEKDAY_COVERAGE_MS = 6 * 24 * 36e5;
const MIN_BUCKET_MS = 30 * 6e4;
function chartPoints(points, now) {
  const start = now - import_price_history.WINDOW_MS;
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const [time, price] = points[i];
    if (time > now) {
      break;
    }
    if (time < start) {
      const next = points[i + 1];
      if (!next || next[0] > start) {
        out.push([start, price]);
      }
      continue;
    }
    out.push([time, price]);
  }
  return out;
}
function segments(points, now) {
  const windowStart = now - import_price_history.WINDOW_MS;
  const result = [];
  for (let i = 0; i < points.length; i++) {
    const [time, price] = points[i];
    if (price === null) {
      continue;
    }
    const start = Math.max(time, windowStart);
    const end = Math.min(i + 1 < points.length ? points[i + 1][0] : now, now);
    if (end > start) {
      result.push({ start, end, price });
    }
  }
  return result;
}
function evaluate(points, current, now) {
  const parts = segments(points, now);
  const coverageMs = parts.reduce((sum, part) => sum + (part.end - part.start), 0);
  const result = {
    rating: "unknown",
    rank: null,
    min: null,
    max: null,
    average: null,
    coverageMs,
    bestHour: null,
    bestHourPrice: null,
    bestWeekday: null,
    bestWeekdayPrice: null,
    hourProfile: Array.from({ length: 24 }, () => null)
  };
  if (coverageMs === 0) {
    return result;
  }
  result.min = Math.min(...parts.map((part) => part.price));
  result.max = Math.max(...parts.map((part) => part.price));
  result.average = round3(parts.reduce((sum, part) => sum + part.price * (part.end - part.start), 0) / coverageMs);
  if (coverageMs < MIN_COVERAGE_MS) {
    return result;
  }
  if (current !== null) {
    let below = 0;
    let above = 0;
    for (const part of parts) {
      const duration = part.end - part.start;
      if (part.price < current) {
        below += duration;
      } else if (part.price > current) {
        above += duration;
      }
    }
    const average = result.average;
    result.rank = Math.round(below / coverageMs * 100) / 100;
    if (below / coverageMs < CHEAP_SHARE && current < average) {
      result.rating = "cheap";
    } else if (above / coverageMs < CHEAP_SHARE && current > average) {
      result.rating = "expensive";
    } else {
      result.rating = "normal";
    }
  }
  const hours = averagesBy(
    parts,
    24,
    (date) => date.getHours(),
    (date) => nextHour(date)
  );
  result.hourProfile = hours.map(
    (entry) => entry.duration < MIN_BUCKET_MS ? null : round3(entry.weighted / entry.duration)
  );
  const bestHour = cheapest(hours);
  if (bestHour) {
    result.bestHour = bestHour.index;
    result.bestHourPrice = bestHour.average;
  }
  if (coverageMs >= MIN_WEEKDAY_COVERAGE_MS) {
    const days = averagesBy(
      parts,
      7,
      (date) => date.getDay(),
      (date) => nextDay(date)
    );
    const bestDay = cheapest(days);
    if (bestDay) {
      result.bestWeekday = bestDay.index;
      result.bestWeekdayPrice = bestDay.average;
    }
  }
  return result;
}
function averagesBy(parts, size, bucket, next) {
  const sums = Array.from({ length: size }, () => ({ weighted: 0, duration: 0 }));
  for (const part of parts) {
    let start = part.start;
    while (start < part.end) {
      const date = new Date(start);
      const end = Math.min(Math.max(next(date), start + 6e4), part.end);
      const entry = sums[bucket(date)];
      entry.weighted += part.price * (end - start);
      entry.duration += end - start;
      start = end;
    }
  }
  return sums;
}
function cheapest(sums) {
  let best;
  sums.forEach((entry, index) => {
    if (entry.duration < MIN_BUCKET_MS) {
      return;
    }
    const average = entry.weighted / entry.duration;
    if (!best || average < best.average) {
      best = { index, average };
    }
  });
  return best ? { index: best.index, average: round3(best.average) } : void 0;
}
function nextHour(date) {
  const next = new Date(date);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return next.getTime();
}
function nextDay(date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  next.setDate(next.getDate() + 1);
  return next.getTime();
}
function round3(value) {
  return Math.round(value * 1e3) / 1e3;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CHEAP_SHARE,
  MIN_COVERAGE_MS,
  MIN_WEEKDAY_COVERAGE_MS,
  chartPoints,
  evaluate,
  segments
});
//# sourceMappingURL=rating.js.map
