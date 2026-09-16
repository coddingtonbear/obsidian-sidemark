import type { TimestampDisplay } from "./settings-model";

export interface TimestampFormatOptions {
  now?: Date;
  locale?: string;
}

export function formatSidebarTimestamp(
  timestamp: string,
  display: TimestampDisplay,
  options: TimestampFormatOptions = {}
): string | null {
  if (display === "hidden") return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return timestamp;

  if (display === "full") return date.toLocaleString(options.locale);
  if (display === "compact") {
    return new Intl.DateTimeFormat(options.locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  const now = options.now ?? new Date();
  const deltaSeconds = (date.getTime() - now.getTime()) / 1000;
  const absoluteSeconds = Math.abs(deltaSeconds);
  const [divisor, unit]: [number, Intl.RelativeTimeFormatUnit] =
    absoluteSeconds < 60
      ? [1, "second"]
      : absoluteSeconds < 3_600
        ? [60, "minute"]
        : absoluteSeconds < 86_400
          ? [3_600, "hour"]
          : absoluteSeconds < 2_592_000
            ? [86_400, "day"]
            : absoluteSeconds < 31_536_000
              ? [2_592_000, "month"]
              : [31_536_000, "year"];
  return new Intl.RelativeTimeFormat(options.locale, { numeric: "auto" }).format(
    Math.round(deltaSeconds / divisor),
    unit
  );
}

/** A very short time for compact cards: "now", "5m", "3h", "2d", then a date ("Aug 11", or "Aug 11, 2025" in another year). */
export function shortTimestamp(timestamp: string, options: TimestampFormatOptions = {}): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return timestamp;
  const now = options.now ?? new Date();
  const seconds = (now.getTime() - date.getTime()) / 1000;
  if (seconds >= 0 && seconds < 60) return "now";
  if (seconds >= 0 && seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds >= 0 && seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  if (seconds >= 0 && seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d`;
  return new Intl.DateTimeFormat(options.locale, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(date);
}
