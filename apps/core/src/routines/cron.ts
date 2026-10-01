/**
 * Supported cron shapes (Phase 15):
 * - interval every N minutes: minute field is star-slash-N, rest stars (UTC-agnostic)
 * - `M H * * *` daily at H:M wall time in the routine's timezone
 * - `M H * * D` weekly on weekday D (0-6, Sunday=0, 7 also Sunday)
 * - `M H * * A-B` on weekdays A through B (e.g. 1-5 is Monday to Friday)
 * - `M H * * A,B,...` on the listed weekdays
 * Anything else throws naming the supported shapes — the agent relays this
 * instead of silently scheduling the wrong cadence.
 */

/**
 * Validates an IANA timezone string.
 * Why: a typo'd zone would schedule in silent limbo; Intl throws on unknown
 * zones, so this is both validator and gate. Pure.
 * Input: zone name. Output: nothing, or throws naming the problem.
 */
export function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error(`Unknown timezone "${timezone}". Use an IANA name like UTC or Europe/Berlin.`);
  }
}

/**
 * Computes the next run instant for a supported cron expression.
 * Why: routines promise "every day at 09:00" in the user's wall time — naive
 * UTC math fires an hour off across DST. Daily/weekly candidates resolve in
 * the zone with a two-pass offset correction; interval math stays absolute.
 * Input: cron text, IANA timezone, optional from-ms (default now).
 * Output: the next run Date strictly after `from`.
 */
export function nextCronRun(cron: string, timezone: string, fromMs: number = Date.now()): Date {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Unsupported schedule "${cron}". Use "*/N * * * *", "M H * * *" (daily), or "M H * * D" (weekly).`);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  const interval = /^\*\/(\d+)$/.exec(minute);
  if (interval && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    const step = Number(interval[1]);
    if (!Number.isInteger(step) || step < 1 || step > 59) {
      throw new Error(`Minute step must be 1-59, got "${minute}".`);
    }
    return new Date(fromMs + step * 60_000);
  }
  const minuteNum = parseField(minute, 0, 59, "minute");
  const hourNum = parseField(hour, 0, 23, "hour");
  if (dayOfMonth !== "*" || month !== "*") {
    throw new Error(`Unsupported schedule "${cron}". Use "*/N * * * *", "M H * * *" (daily), or "M H * * D" (weekly).`);
  }
  assertTimezone(timezone);
  if (dayOfWeek === "*") {
    return nextDaily(minuteNum, hourNum, timezone, fromMs);
  }
  return nextWeeklySet(minuteNum, hourNum, parseWeekdays(dayOfWeek, cron), timezone, fromMs);
}

/**
 * Parses a weekday field into the matching weekday set.
 * Why: "Weekdays at 9:32 AM" is `M H * * 1-5` — one routine, five days.
 * Input: the raw field ("1", "1-5", "1,3,5") and the full cron for errors.
 * Output: weekdays as 0=Sunday..6=Saturday. Throws naming the shape.
 */
function parseWeekdays(raw: string, cron: string): Set<number> {
  const days = new Set<number>();
  for (const part of raw.split(",")) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const start = weekdayNumber(range[1] ?? "", cron);
      const end = weekdayNumber(range[2] ?? "", cron);
      if (start > end) {
        throw new Error(`Unsupported schedule "${cron}". Weekday ranges run forward, e.g. "1-5".`);
      }
      for (let day = start; day <= end; day += 1) {
        days.add(day);
      }
      continue;
    }
    days.add(weekdayNumber(part, cron));
  }
  if (days.size === 0) {
    throw new Error(`Unsupported schedule "${cron}". Use "*/N * * * *", "M H * * *" (daily), or "M H * * D" (weekly).`);
  }
  return days;
}

/** Parses one weekday number. Input: raw digits. Output: 0=Sunday..6=Saturday (7 folds to 0). */
function weekdayNumber(raw: string, cron: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Unsupported schedule "${cron}". Weekdays must be numbers 0-7, ranges like "1-5", or lists like "1,3,5".`);
  }
  const value = Number(raw);
  if (value < 0 || value > 7) {
    throw new Error(`Unsupported schedule "${cron}". Weekdays must be 0-7, got "${raw}".`);
  }
  return value === 7 ? 0 : value;
}

function parseField(raw: string, min: number, max: number, name: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Unsupported schedule: ${name} must be a number, got "${raw}".`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new Error(`Unsupported schedule: ${name} must be ${min}-${max}, got "${raw}".`);
  }
  return value;
}

/**
 * Finds the next daily H:M wall time in the zone.
 * Why: day-stepped with two-pass DST correction — the offset is measured at
 * the candidate itself, so spring-forward/fall-back days still land on the
 * wall time the user asked for.
 */
function nextDaily(minute: number, hour: number, timezone: string, fromMs: number): Date {
  for (let day = 0; day < 3; day += 1) {
    const wall = wallParts(timezone, fromMs + day * 86_400_000);
    const candidate = wallToInstant(timezone, wall.year, wall.month, wall.day, hour, minute);
    if (candidate.getTime() > fromMs) return candidate;
  }
  throw new Error("Could not resolve the next daily run.");
}

/**
 * Finds the next H:M on one of the given weekdays in the zone.
 * Why: same wall-time math as daily, stepping forward to the next matching
 * weekday first (up to 9 days covers a same-day miss plus a full week gap).
 */
function nextWeeklySet(minute: number, hour: number, weekdays: Set<number>, timezone: string, fromMs: number): Date {
  for (let day = 0; day < 10; day += 1) {
    const wall = wallParts(timezone, fromMs + day * 86_400_000);
    if (!weekdays.has(wall.weekday)) continue;
    const candidate = wallToInstant(timezone, wall.year, wall.month, wall.day, hour, minute);
    if (candidate.getTime() > fromMs) return candidate;
  }
  throw new Error("Could not resolve the next weekly run.");
}

type WallParts = { year: number; month: number; day: number; weekday: number };

/**
 * Reads calendar wall parts for an instant in a zone.
 * Why: single Intl call per probe; weekday mapped to 0=Sunday..6=Saturday.
 * Input: zone + epoch ms. Output: {year, month, day, weekday}.
 */
function wallParts(timezone: string, epochMs: number): WallParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).formatToParts(new Date(epochMs));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const weekdayName = get("weekday");
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayName);
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), weekday };
}

/**
 * Converts zone wall time to an instant with DST correction.
 * Why: Date.UTC assumes zero offset; measuring the real offset at the first
 * guess and re-applying lands within the same wall minute even across a DST
 * cutover. Two passes converge for all real zones.
 * Input: zone + wall fields. Output: the instant Date.
 */
function wallToInstant(timezone: string, year: number, month: number, day: number, hour: number, minute: number): Date {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let pass = 0; pass < 2; pass += 1) {
    guess = Date.UTC(year, month - 1, day, hour, minute) - tzOffsetMs(timezone, guess);
  }
  return new Date(guess);
}

/**
 * Measures a zone's offset (wall minus instant) at one instant.
 * Why: Intl formats wall time; reinterpreting those parts as UTC and
 * subtracting the true instant yields the offset. Pure arithmetic, no deps.
 * Input: zone + epoch ms. Output: offset ms (positive east of UTC).
 */
function tzOffsetMs(timezone: string, epochMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(epochMs));
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - epochMs;
}
