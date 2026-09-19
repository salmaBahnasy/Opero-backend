const EGYPT_TIMEZONE = "Africa/Cairo";

function getZonedParts(date, timeZone = EGYPT_TIMEZONE) {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== "literal") {
      parts[p.type] = p.value;
    }
  }

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/**
 * Wall-clock in Egypt (Africa/Cairo) → UTC Date.
 */
function egyptLocalToUtc(
  year,
  month,
  day,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
) {
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);

  for (let i = 0; i < 5; i++) {
    const zoned = getZonedParts(new Date(utcMs));
    const zonedAsUtc = Date.UTC(
      zoned.year,
      zoned.month - 1,
      zoned.day,
      zoned.hour,
      zoned.minute,
      zoned.second,
      millisecond,
    );
    const desiredAsUtc = Date.UTC(
      year,
      month - 1,
      day,
      hour,
      minute,
      second,
      millisecond,
    );
    utcMs += desiredAsUtc - zonedAsUtc;
  }

  return new Date(utcMs);
}

/**
 * First day of current month 00:00:00 Egypt → now (Egypt), as UTC Date objects.
 */
function getEgyptMonthToDateRange(now = new Date()) {
  const egyptNow = getZonedParts(now);
  const from = egyptLocalToUtc(egyptNow.year, egyptNow.month, 1, 0, 0, 0, 0);
  const to = now;
  return { from, to };
}

/** آخر 30 يومًا بتوقيت مصر (شامل اليوم الحالي) — افتراضي لجرافات التكلفة */
function getEgyptLast30DaysRange(now = new Date()) {
  const egyptNow = getZonedParts(now);
  const start = addEgyptCalendarDays(egyptNow.year, egyptNow.month, egyptNow.day, -29);
  const from = egyptLocalToUtc(
    start.year,
    start.month,
    start.day,
    0,
    0,
    0,
    0,
  );
  return { from, to: now };
}

/**
 * Full calendar day in Egypt for YYYY-MM-DD → UTC bounds.
 * @param {string} date - e.g. "2026-05-23"
 */
function getEgyptDayRange(date) {
  const m = String(date || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    const err = new Error('date must be "YYYY-MM-DD"');
    err.code = "INVALID_DATE";
    throw err;
  }

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);

  const from = egyptLocalToUtc(year, month, day, 0, 0, 0, 0);
  const to = egyptLocalToUtc(year, month, day, 23, 59, 59, 999);

  return { from, to };
}

/** Query value (YYYY-MM-DD or ISO) → that calendar day in Egypt. */
function resolveSingleDayFromQueryValue(raw) {
  const s = String(Array.isArray(raw) ? raw[0] : raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return getEgyptDayRange(s);
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    const err = new Error('date must be "YYYY-MM-DD" or a valid ISO date');
    err.code = "INVALID_DATE";
    throw err;
  }
  return getEgyptDayRange(getEgyptCalendarDateKey(d));
}

function formatYmd(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** YYYY-MM-DD in Egypt (Africa/Cairo) for a UTC instant. */
function getEgyptCalendarDateKey(date) {
  const p = getZonedParts(date);
  return formatYmd(p.year, p.month, p.day);
}

function getEgyptWeekdayIndex(date) {
  const w = new Intl.DateTimeFormat("en-US", {
    timeZone: EGYPT_TIMEZONE,
    weekday: "short",
  }).format(date);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[w] ?? 0;
}

function addEgyptCalendarDays(year, month, day, deltaDays) {
  const utc = egyptLocalToUtc(year, month, day, 12, 0, 0, 0);
  const next = new Date(utc.getTime() + deltaDays * 86400000);
  return getZonedParts(next);
}

/**
 * Trend bucket key in Egypt local calendar (day / week-start Monday / month).
 */
function getEgyptTrendBucketKey(date, granularity) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;

  if (granularity === "month") {
    const p = getZonedParts(d);
    return `${p.year}-${String(p.month).padStart(2, "0")}`;
  }

  if (granularity === "week") {
    const p = getZonedParts(d);
    const wd = getEgyptWeekdayIndex(d);
    const diff = wd === 0 ? -6 : 1 - wd;
    const monday = addEgyptCalendarDays(p.year, p.month, p.day, diff);
    return formatYmd(monday.year, monday.month, monday.day);
  }

  return getEgyptCalendarDateKey(d);
}

/**
 * All bucket keys between from/to (UTC instants) on Egypt calendar.
 */
function listEgyptTrendBucketKeys(from, to, granularity = "day") {
  const endKey =
    granularity === "month"
      ? getEgyptTrendBucketKey(to, "month")
      : getEgyptCalendarDateKey(to);

  if (granularity === "day") {
    const keys = [];
    let { year, month, day } = getZonedParts(from);
    for (;;) {
      const key = formatYmd(year, month, day);
      keys.push(key);
      if (key >= endKey) break;
      ({ year, month, day } = addEgyptCalendarDays(year, month, day, 1));
    }
    return keys;
  }

  const keys = [];
  const seen = new Set();
  let { year, month, day } = getZonedParts(from);
  const endMs = to.getTime();

  for (;;) {
    const utc = egyptLocalToUtc(year, month, day, 12, 0, 0, 0);
    if (utc.getTime() > endMs) break;

    const k = getEgyptTrendBucketKey(utc, granularity);
    if (k && !seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }

    if (getEgyptCalendarDateKey(utc) >= getEgyptCalendarDateKey(to)) break;
    ({ year, month, day } = addEgyptCalendarDays(year, month, day, 1));
  }

  return keys;
}

function isEasyOrderApiRequest(req) {
  const original = String(req.originalUrl || req.url || "");
  const base = String(req.baseUrl || "");
  return original.includes("/api/easyorder") || base.includes("/easyorder");
}

/**
 * EasyOrder routes: default = Egypt month-to-date when from & to omitted.
 * Otherwise parse query values as-is.
 */
function resolveEasyOrderDateRange(req) {
  const fromRaw = req.query?.from;
  const toRaw = req.query?.to;
  const hasFrom =
    fromRaw != null && String(Array.isArray(fromRaw) ? fromRaw[0] : fromRaw).trim() !== "";
  const hasTo =
    toRaw != null && String(Array.isArray(toRaw) ? toRaw[0] : toRaw).trim() !== "";

  if (!hasFrom && !hasTo) {
    const { from, to } = getEgyptMonthToDateRange();
    console.log("DATE_FILTER", {
      from: from.toISOString(),
      to: to.toISOString(),
    });
    return { from, to, usedDefault: true };
  }

  let from = null;
  let to = null;

  if (hasFrom) {
    from = new Date(Array.isArray(fromRaw) ? fromRaw[0] : fromRaw);
    if (Number.isNaN(from.getTime())) {
      const err = new Error("Invalid from date");
      err.code = "INVALID_FROM";
      throw err;
    }
  }

  if (hasTo) {
    to = new Date(Array.isArray(toRaw) ? toRaw[0] : toRaw);
    if (Number.isNaN(to.getTime())) {
      const err = new Error("Invalid to date");
      err.code = "INVALID_TO";
      throw err;
    }
  }

  console.log("DATE_FILTER", {
    from: from ? from.toISOString() : null,
    to: to ? to.toISOString() : null,
  });

  return { from, to, usedDefault: false };
}

function getEgyptTodayRange(now = new Date()) {
  return getEgyptDayRange(getEgyptCalendarDateKey(now));
}

function getEgyptYesterdayRange(now = new Date()) {
  const p = getZonedParts(now);
  const y = addEgyptCalendarDays(p.year, p.month, p.day, -1);
  return getEgyptDayRange(formatYmd(y.year, y.month, y.day));
}

function getEgyptInclusiveLastDaysRange(days, now = new Date()) {
  const n = Math.max(1, Number(days) || 1);
  const egyptNow = getZonedParts(now);
  const start = addEgyptCalendarDays(
    egyptNow.year,
    egyptNow.month,
    egyptNow.day,
    -(n - 1),
  );
  return {
    from: egyptLocalToUtc(start.year, start.month, start.day, 0, 0, 0, 0),
    to: egyptLocalToUtc(
      egyptNow.year,
      egyptNow.month,
      egyptNow.day,
      23,
      59,
      59,
      999,
    ),
  };
}

function daysInEgyptMonth(year, month) {
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const firstNext = egyptLocalToUtc(nextYear, nextMonth, 1, 0, 0, 0, 0);
  const last = new Date(firstNext.getTime() - 1);
  return getZonedParts(last).day;
}

function getEgyptThisMonthRange(now = new Date()) {
  const p = getZonedParts(now);
  return {
    from: egyptLocalToUtc(p.year, p.month, 1, 0, 0, 0, 0),
    to: egyptLocalToUtc(p.year, p.month, p.day, 23, 59, 59, 999),
  };
}

function getEgyptLastCalendarMonthRange(now = new Date()) {
  const p = getZonedParts(now);
  const month = p.month === 1 ? 12 : p.month - 1;
  const year = p.month === 1 ? p.year - 1 : p.year;
  const lastDay = daysInEgyptMonth(year, month);
  return {
    from: egyptLocalToUtc(year, month, 1, 0, 0, 0, 0),
    to: egyptLocalToUtc(year, month, lastDay, 23, 59, 59, 999),
  };
}

function previousCalendarMonthMtd(from, to) {
  const start = getZonedParts(from);
  const end = getZonedParts(to);
  const month = start.month === 1 ? 12 : start.month - 1;
  const year = start.month === 1 ? start.year - 1 : start.year;
  const lastDay = daysInEgyptMonth(year, month);
  const mtdDay = Math.min(end.day, lastDay);
  return {
    from: egyptLocalToUtc(year, month, 1, 0, 0, 0, 0),
    to: egyptLocalToUtc(year, month, mtdDay, 23, 59, 59, 999),
  };
}

function previousFullCalendarMonth(from) {
  const start = getZonedParts(from);
  const month = start.month === 1 ? 12 : start.month - 1;
  const year = start.month === 1 ? start.year - 1 : start.year;
  const lastDay = daysInEgyptMonth(year, month);
  return {
    from: egyptLocalToUtc(year, month, 1, 0, 0, 0, 0),
    to: egyptLocalToUtc(year, month, lastDay, 23, 59, 59, 999),
  };
}

function previousEqualDurationRange(from, to) {
  const durationMs = Math.max(0, to.getTime() - from.getTime());
  const prevTo = new Date(from.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - durationMs);
  return { from: prevFrom, to: prevTo };
}

function resolveEgyptPresetRange(preset, now = new Date()) {
  const key = String(preset || "").trim();
  if (key === "today") return getEgyptTodayRange(now);
  if (key === "yesterday") return getEgyptYesterdayRange(now);
  if (key === "last_7_days" || key === "7d") {
    return getEgyptInclusiveLastDaysRange(7, now);
  }
  if (key === "last_30_days" || key === "30d") {
    return getEgyptInclusiveLastDaysRange(30, now);
  }
  if (key === "this_month" || key === "month") {
    return getEgyptThisMonthRange(now);
  }
  if (key === "last_month") return getEgyptLastCalendarMonthRange(now);
  return null;
}

function previousEquivalentRange({ preset, from, to }) {
  const key = String(preset || "").trim();
  if (key === "this_month" || key === "month") {
    return previousCalendarMonthMtd(from, to);
  }
  if (key === "last_month") {
    return previousFullCalendarMonth(from);
  }
  return previousEqualDurationRange(from, to);
}

module.exports = {
  EGYPT_TIMEZONE,
  getEgyptMonthToDateRange,
  getEgyptLast30DaysRange,
  getEgyptDayRange,
  resolveSingleDayFromQueryValue,
  getEgyptCalendarDateKey,
  getEgyptTrendBucketKey,
  listEgyptTrendBucketKeys,
  egyptLocalToUtc,
  isEasyOrderApiRequest,
  resolveEasyOrderDateRange,
  getEgyptTodayRange,
  getEgyptYesterdayRange,
  getEgyptInclusiveLastDaysRange,
  getEgyptThisMonthRange,
  getEgyptLastCalendarMonthRange,
  resolveEgyptPresetRange,
  previousEquivalentRange,
  getZonedParts,
};
