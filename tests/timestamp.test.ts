import { describe, expect, it } from "vitest";
import { formatSidebarTimestamp, shortTimestamp } from "../src/timestamp";

describe("sidebar timestamp formatting", () => {
  const timestamp = "2026-08-11T10:30:00Z";

  it("shows full and compact timestamps", () => {
    expect(formatSidebarTimestamp(timestamp, "full", { locale: "en-US" })).toContain("2026");
    expect(formatSidebarTimestamp(timestamp, "compact", { locale: "en-US" })).toContain("Aug");
  });

  it("shows relative timestamps against the supplied time", () => {
    expect(
      formatSidebarTimestamp(timestamp, "relative", {
        now: new Date("2026-08-11T12:30:00Z"),
        locale: "en",
      })
    ).toBe("2 hours ago");
  });

  it("can hide timestamps and preserves malformed values otherwise", () => {
    expect(formatSidebarTimestamp(timestamp, "hidden")).toBeNull();
    expect(formatSidebarTimestamp("not-a-date", "compact")).toBe("not-a-date");
  });
});

describe("shortTimestamp", () => {
  const now = new Date("2026-08-11T12:00:00Z");
  const at = (iso: string) => shortTimestamp(iso, { now, locale: "en-US" });

  it("counts recent times in minutes, hours and days", () => {
    expect(at("2026-08-11T11:59:30Z")).toBe("now");
    expect(at("2026-08-11T11:55:00Z")).toBe("5m");
    expect(at("2026-08-11T09:00:00Z")).toBe("3h");
    expect(at("2026-08-09T12:00:00Z")).toBe("2d");
  });

  it("shows a date for older or future times, with the year only when it differs", () => {
    expect(at("2026-07-01T12:00:00Z")).toBe("Jul 1");
    expect(at("2025-07-01T12:00:00Z")).toBe("Jul 1, 2025");
    expect(at("2026-09-01T12:00:00Z")).toBe("Sep 1");
    expect(at("garbage")).toBe("garbage");
  });
});
