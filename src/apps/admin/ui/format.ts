/**
 * Pure presentation helpers. Credit and money values arrive as decimal strings because they can
 * exceed 2^53; they are only ever handled as BigInt here, never summed or scaled as Number.
 */
export type Numeric = string | number | bigint;

const DASH = "—";

export function integer(value: Numeric | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return /^-?\d+$/.test(text) ? BigInt(text) : null;
}

/** 1234567 -> "1,234,567". Locale-independent so every operator sees the same text. */
function group(value: bigint): string {
  const text = (value < 0n ? -value : value).toString();
  const grouped = text.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return value < 0n ? `−${grouped}` : grouped;
}

export function count(value: Numeric | null | undefined): string {
  const parsed = integer(value);
  return parsed === null ? DASH : group(parsed);
}

/** Divide by a power-of-ten scale with a decimal tail of at least `minimum` digits. */
export function scaled(
  value: Numeric | null | undefined,
  divisor: Numeric,
  minimum = 0,
  maximum = Number.POSITIVE_INFINITY,
): string {
  const amount = integer(value);
  const scale = integer(divisor);
  if (amount === null || scale === null || scale <= 0n) return DASH;
  const precision = scale.toString().length - 1;
  if (scale !== 10n ** BigInt(precision)) return DASH;
  const negative = amount < 0n;
  let absolute = negative ? -amount : amount;
  let digits = precision;
  if (digits > maximum) {
    // Round half away from zero to the requested number of decimals.
    const drop = 10n ** BigInt(digits - maximum);
    absolute = (absolute + drop / 2n) / drop;
    digits = maximum;
  }
  const factor = 10n ** BigInt(digits);
  const whole = absolute / factor;
  const fraction = (absolute % factor)
    .toString()
    .padStart(digits, "0")
    .replace(/0+$/, "")
    .padEnd(minimum, "0");
  const isZero = whole === 0n && fraction.replaceAll("0", "") === "";
  return `${negative && !isZero ? "−" : ""}${group(whole)}${fraction ? `.${fraction}` : ""}`;
}

/** USD micros -> "$12.34"; sub-dollar amounts keep up to four decimals so small costs stay visible. */
export function usd(micros: Numeric | null | undefined): string {
  const amount = integer(micros);
  if (amount === null) return DASH;
  const magnitude = amount < 0n ? -amount : amount;
  const text = scaled(micros, "1000000", 2, magnitude >= 1_000_000n ? 2 : 4);
  return text === DASH ? text : text.startsWith("−") ? `−$${text.slice(1)}` : `$${text}`;
}

/** Lossless USD micros, e.g. "$0.004123". */
export function usdExact(micros: Numeric | null | undefined): string {
  const text = scaled(micros, "1000000", 2);
  return text === DASH ? text : text.startsWith("−") ? `−$${text.slice(1)}` : `$${text}`;
}

/** Minor currency units (cents) -> "$20.00". */
export function usdMinor(minor: Numeric | null | undefined): string {
  const text = scaled(minor, "100", 2);
  return text === DASH ? text : text.startsWith("−") ? `−$${text.slice(1)}` : `$${text}`;
}

/** Internal credit units -> customer-facing credits. */
export function credits(units: Numeric | null | undefined, creditUnits: Numeric): string {
  return scaled(units, creditUnits, 0, 2);
}

/** A plain number used only to position chart marks, never displayed or accumulated. */
export function microsToDollars(micros: Numeric): number {
  const amount = integer(micros);
  return amount === null ? 0 : Number(amount / 1000n) / 1000;
}

/** spent / cap in basis points (1% = 100), capped at 10x the cap. Null when there is no usable cap. */
export function basisPoints(
  spent: Numeric | null | undefined,
  cap: Numeric | null | undefined,
): number | null {
  const used = integer(spent);
  const limit = integer(cap);
  if (used === null || limit === null || limit <= 0n) return null;
  const ratio = (used * 10000n) / limit;
  return Number(ratio > 100000n ? 100000n : ratio < 0n ? 0n : ratio);
}

export type Level = "ok" | "warn" | "critical";
/** 80% and 100% thresholds from the operating policy. */
export function budgetLevel(bp: number): Level {
  return bp >= 10000 ? "critical" : bp >= 8000 ? "warn" : "ok";
}

export function percent(bp: number): string {
  const tenths = Math.round(bp / 10);
  return `${(tenths / 10).toFixed(Number.isInteger(tenths / 10) ? 0 : 1)}%`;
}

/** Ratio of two small counts, formatted "3.4%". Counts are 32-bit integers from the API. */
export function rate(part: Numeric, whole: Numeric): string {
  const a = integer(part);
  const b = integer(whole);
  if (a === null || b === null || b <= 0n) return DASH;
  return percent(Number((a * 10000n) / b));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/** Normalise any API timestamp to UTC parts, or null when it is missing or malformed. */
function utcParts(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = ISO.exec(value);
  if (match && match[7] === "Z" && Number.isFinite(Date.parse(`${value.slice(0, 19)}Z`))) {
    return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
  }
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? null : time.toISOString().slice(0, 19);
}

/** "2026-10-31 14:03" (UTC). Column headings or the caller say UTC; pass `label` to append it. */
export function utc(
  value: string | null | undefined,
  options: { seconds?: boolean; label?: boolean } = {},
): string {
  const parts = utcParts(value);
  if (!parts) return DASH;
  const text = `${parts.slice(0, 10)} ${parts.slice(11, options.seconds ? 19 : 16)}`;
  return options.label ? `${text} UTC` : text;
}

export function utcDate(value: string | null | undefined): string {
  const parts = utcParts(value);
  return parts ? parts.slice(0, 10) : DASH;
}

/** "2026-10-31" -> "Oct 31". Works on the string, so the viewer's time zone cannot shift the day. */
export function dayLabel(day: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(day);
  const month = match ? MONTHS[Number(match[1]) - 1] : undefined;
  return match && month ? `${month} ${Number(match[2])}` : day;
}

export function nowUtc(date = new Date()): string {
  return utc(date.toISOString(), { seconds: true, label: true });
}

/** 3725 -> "1h 2m". Two most significant units. */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0)
    return DASH;
  const total = Math.floor(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m${total % 60 ? ` ${total % 60}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
}

/** 12400 -> "12.4k" for chart axes. */
export function compact(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (magnitude >= 1000) return `${trim(value / 1000)}k`;
  return trim(value, 2);
}
function trim(value: number, decimals = 1): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
}

export function planName(plan: string | null | undefined): string {
  switch (plan) {
    case "free":
      return "Free";
    case "pro":
      return "Pro";
    case "max":
      return "Max";
    case undefined:
    case null:
      return DASH;
    default:
      return plan.length > 0 ? plan.charAt(0).toUpperCase() + plan.slice(1) : DASH;
  }
}

export function intervalName(interval: string): string {
  return interval === "monthly" ? "Monthly" : interval === "yearly" ? "Yearly" : "Unknown";
}

/** "usage_export" -> "Usage export". */
export function humanize(code: string): string {
  const text = code.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Exact total of decimal-string amounts (credit units or USD micros). */
export function sumUnits(values: readonly Numeric[]): string {
  let total = 0n;
  for (const value of values) total += integer(value) ?? 0n;
  return total.toString();
}
