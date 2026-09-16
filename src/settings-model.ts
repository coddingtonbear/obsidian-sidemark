import { normalizeAuthorColorOverrides, type AuthorColorOverrides } from "./author-color";
import type { ResolveBehavior } from "./mutations";

export type { ResolveBehavior };
export type SidebarSortOrder = "document" | "newest" | "oldest";
export type SubmitShortcut = "enter" | "mod-enter";
export type TimestampDisplay = "full" | "compact" | "relative" | "hidden";

export interface SidemarkSettings {
  highlightColor: string;
  highlightOpacity: number;
  colorAuthorNames: boolean;
  showResolvedByDefault: boolean;
  resolveBehavior: ResolveBehavior;
  sidebarSortOrder: SidebarSortOrder;
  submitShortcut: SubmitShortcut;
  timestampDisplay: TimestampDisplay;
  confirmDestructiveActions: boolean;
  authorColorOverrides: AuthorColorOverrides;
  /** Show open suggestions in the note as struck-out text followed by the replacement. */
  showSuggestionsInline: boolean;
  /** Whether the comment panel has been added to the sidebar once already. */
  sidebarAdded: boolean;
}

export const DEFAULT_SETTINGS: SidemarkSettings = {
  highlightColor: "#ffd54a",
  highlightOpacity: 30,
  colorAuthorNames: true,
  showResolvedByDefault: false,
  // Resolved threads live in the sidecar, not the note, so keeping them as
  // history costs nothing in the note itself.
  resolveBehavior: "keep",
  sidebarSortOrder: "document",
  submitShortcut: "enter",
  timestampDisplay: "full",
  confirmDestructiveActions: true,
  authorColorOverrides: {},
  showSuggestionsInline: true,
  sidebarAdded: false,
};

export interface SettingsEffects {
  refreshHighlights: boolean;
  /** Editor decorations must be rebuilt. */
  refreshEditors: boolean;
  refreshSidebar: boolean;
  resetResolvedVisibility: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function booleanSetting(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function enumSetting<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : fallback;
}

function opacitySetting(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SETTINGS.highlightOpacity;
  return Math.min(80, Math.max(10, Math.round(value)));
}

/** Turns whatever `loadData()` returned into complete, valid settings. */
export function parseSettings(value: unknown): SidemarkSettings {
  const raw = isRecord(value) ? value : {};
  return {
    highlightColor:
      typeof raw.highlightColor === "string" && /^#[0-9a-f]{6}$/i.test(raw.highlightColor)
        ? raw.highlightColor.toLowerCase()
        : DEFAULT_SETTINGS.highlightColor,
    highlightOpacity: opacitySetting(raw.highlightOpacity),
    colorAuthorNames: booleanSetting(raw.colorAuthorNames, DEFAULT_SETTINGS.colorAuthorNames),
    showResolvedByDefault: booleanSetting(raw.showResolvedByDefault, DEFAULT_SETTINGS.showResolvedByDefault),
    resolveBehavior: enumSetting(raw.resolveBehavior, ["keep", "remove"] as const, DEFAULT_SETTINGS.resolveBehavior),
    sidebarSortOrder: enumSetting(
      raw.sidebarSortOrder,
      ["document", "newest", "oldest"] as const,
      DEFAULT_SETTINGS.sidebarSortOrder
    ),
    submitShortcut: enumSetting(raw.submitShortcut, ["enter", "mod-enter"] as const, DEFAULT_SETTINGS.submitShortcut),
    timestampDisplay: enumSetting(
      raw.timestampDisplay,
      ["full", "compact", "relative", "hidden"] as const,
      DEFAULT_SETTINGS.timestampDisplay
    ),
    confirmDestructiveActions: booleanSetting(raw.confirmDestructiveActions, DEFAULT_SETTINGS.confirmDestructiveActions),
    authorColorOverrides: normalizeAuthorColorOverrides(raw.authorColorOverrides),
    showSuggestionsInline: booleanSetting(raw.showSuggestionsInline, DEFAULT_SETTINGS.showSuggestionsInline),
    sidebarAdded: booleanSetting(raw.sidebarAdded, DEFAULT_SETTINGS.sidebarAdded),
  };
}

export function settingsEffects(previous: SidemarkSettings, next: SidemarkSettings): SettingsEffects {
  const resetResolvedVisibility = previous.showResolvedByDefault !== next.showResolvedByDefault;
  return {
    refreshHighlights:
      previous.highlightColor !== next.highlightColor || previous.highlightOpacity !== next.highlightOpacity,
    refreshEditors: previous.showSuggestionsInline !== next.showSuggestionsInline,
    refreshSidebar:
      resetResolvedVisibility ||
      previous.sidebarSortOrder !== next.sidebarSortOrder ||
      previous.timestampDisplay !== next.timestampDisplay ||
      previous.colorAuthorNames !== next.colorAuthorNames ||
      previous.submitShortcut !== next.submitShortcut,
    resetResolvedVisibility,
  };
}

interface SubmitKeyEvent {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

export function shouldSubmitComment(event: SubmitKeyEvent, shortcut: SubmitShortcut): boolean {
  if (event.key !== "Enter") return false;
  return shortcut === "enter" ? !event.shiftKey && !event.metaKey && !event.ctrlKey : event.metaKey || event.ctrlKey;
}
