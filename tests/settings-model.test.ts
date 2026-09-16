import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, parseSettings, settingsEffects, shouldSubmitComment } from "../src/settings-model";

describe("parseSettings", () => {
  it("fills in defaults for missing or invalid values", () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ highlightColor: "red", highlightOpacity: 500, resolveBehavior: "maybe" })).toMatchObject({
      highlightColor: DEFAULT_SETTINGS.highlightColor,
      highlightOpacity: 80,
      resolveBehavior: "keep",
    });
  });

  it("keeps valid values", () => {
    expect(parseSettings({ highlightColor: "#ABCDEF", resolveBehavior: "remove", timestampDisplay: "relative" })).toMatchObject({
      highlightColor: "#abcdef",
      resolveBehavior: "remove",
      timestampDisplay: "relative",
    });
  });
});

describe("settingsEffects", () => {
  it("rebuilds editor decorations when inline suggestions are toggled", () => {
    const off = parseSettings({ showSuggestionsInline: false });
    expect(off.showSuggestionsInline).toBe(false);
    expect(settingsEffects(DEFAULT_SETTINGS, off).refreshEditors).toBe(true);
    expect(settingsEffects(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, colorAuthorNames: false }).refreshEditors).toBe(false);
  });
});

describe("shouldSubmitComment", () => {
  const key = (k: string, mods: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }> = {}) => ({
    key: k,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    ...mods,
  });

  it("submits on plain Enter in enter mode, but not Shift+Enter", () => {
    expect(shouldSubmitComment(key("Enter"), "enter")).toBe(true);
    expect(shouldSubmitComment(key("Enter", { shiftKey: true }), "enter")).toBe(false);
  });

  it("requires Cmd/Ctrl in mod-enter mode", () => {
    expect(shouldSubmitComment(key("Enter"), "mod-enter")).toBe(false);
    expect(shouldSubmitComment(key("Enter", { ctrlKey: true }), "mod-enter")).toBe(true);
    expect(shouldSubmitComment(key("a", { ctrlKey: true }), "mod-enter")).toBe(false);
  });
});
