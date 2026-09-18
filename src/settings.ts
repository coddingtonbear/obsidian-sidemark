import { type App, Notice, Platform, PluginSettingTab, type SettingDefinitionItem } from "obsidian";
import type SidemarkPlugin from "./main";
import { DEFAULT_SETTINGS, parseSettings, type SidemarkSettings } from "./settings-model";
import { exportSkill } from "./skill-export";

/** The parts of the plugin the settings tab reads and writes. */
export interface SettingsHost {
  readonly settings: SidemarkSettings;
  updateSettings(patch: Partial<SidemarkSettings>): Promise<void>;
  detectedAuthor(): string;
  authorOverride(): string;
  setAuthorOverride(value: string): void;
  migrateTandem(): Promise<void>;
}

/**
 * Keys bound to declarative controls. `authorName` is the device-local name
 * override, which lives in local storage rather than in the synced settings;
 * the rest are settings fields.
 */
export type SettingsControlKey =
  | "authorName"
  | Exclude<keyof SidemarkSettings, "highlightColor" | "authorColorOverrides" | "sidebarAdded">;

const CONTROL_KEYS: ReadonlySet<string> = new Set<SettingsControlKey>([
  "authorName",
  "highlightOpacity",
  "colorAuthorNames",
  "showResolvedByDefault",
  "resolveBehavior",
  "sidebarSortOrder",
  "submitShortcut",
  "timestampDisplay",
  "confirmDestructiveActions",
  "showSuggestionsInline",
]);

function isControlKey(key: string): key is SettingsControlKey {
  return CONTROL_KEYS.has(key);
}

export function readControl(host: SettingsHost, key: string): unknown {
  if (!isControlKey(key)) return undefined;
  return key === "authorName" ? host.authorOverride() : host.settings[key];
}

export async function writeControl(host: SettingsHost, key: string, value: unknown): Promise<void> {
  if (!isControlKey(key)) return;
  if (key === "authorName") {
    if (typeof value === "string") host.setAuthorOverride(value);
    return;
  }
  // parseSettings validates the value, the same way it does data loaded from disk.
  await host.updateSettings(parseSettings({ ...host.settings, [key]: value }));
}

/**
 * The settings tab, grouped by where each setting shows up: the note, the
 * sidebar, what happens when threads are resolved or deleted, then one-off tools.
 */
export function settingDefinitions(
  host: SettingsHost,
  options: { desktopApp: boolean }
): SettingDefinitionItem<SettingsControlKey>[] {
  return [
    {
      type: "group",
      items: [
        {
          name: "Your name",
          desc: "Shown on comments you write from this device. Stored on this device only, so people sharing a vault keep their own names.",
          control: { type: "text", key: "authorName", placeholder: host.detectedAuthor() },
        },
      ],
    },
    {
      type: "group",
      heading: "In the note",
      items: [
        {
          name: "Highlight color",
          render: (setting) => {
            setting.addColorPicker((picker) => {
              picker
                .setValue(host.settings.highlightColor)
                .onChange((value) => void host.updateSettings({ highlightColor: value }));
              setting.addExtraButton((button) =>
                button
                  .setIcon("rotate-ccw")
                  .setTooltip("Reset")
                  .onClick(async () => {
                    await host.updateSettings({ highlightColor: DEFAULT_SETTINGS.highlightColor });
                    picker.setValue(DEFAULT_SETTINGS.highlightColor);
                  })
              );
            });
          },
        },
        {
          name: "Highlight opacity",
          control: { type: "slider", key: "highlightOpacity", min: 10, max: 80, step: 5, displayFormat: (value) => `${value}%` },
        },
        {
          name: "Show suggestions in the note",
          desc: "Strike through the text a suggestion would replace and show the replacement after it. Turn off to highlight suggestions like comments.",
          control: { type: "toggle", key: "showSuggestionsInline" },
        },
      ],
    },
    {
      type: "group",
      heading: "In the sidebar",
      items: [
        {
          name: "Sort threads by",
          control: {
            type: "dropdown",
            key: "sidebarSortOrder",
            options: { document: "Position in note", newest: "Newest activity", oldest: "Oldest activity" },
          },
        },
        {
          name: "Timestamps",
          control: {
            type: "dropdown",
            key: "timestampDisplay",
            options: { full: "Full", compact: "Compact", relative: "Relative (5 minutes ago)", hidden: "Hidden" },
          },
        },
        {
          name: "Send comments with",
          control: {
            type: "dropdown",
            key: "submitShortcut",
            options: { enter: "Enter (Shift+Enter for a new line)", "mod-enter": "Cmd/Ctrl+Enter" },
          },
        },
        {
          name: "Color author names",
          desc: "Give each author a consistent color in the sidebar.",
          control: { type: "toggle", key: "colorAuthorNames" },
        },
      ],
    },
    {
      type: "group",
      heading: "Resolving and deleting",
      items: [
        {
          name: "When a thread is resolved",
          desc: "Keeping resolved threads leaves them in the comment file as history; they never appear in the note itself.",
          control: {
            type: "dropdown",
            key: "resolveBehavior",
            options: { keep: "Keep it as resolved", remove: "Delete it" },
          },
        },
        {
          name: "Show resolved threads by default",
          visible: () => host.settings.resolveBehavior === "keep",
          control: { type: "toggle", key: "showResolvedByDefault" },
        },
        {
          name: "Confirm before deleting",
          control: { type: "toggle", key: "confirmDestructiveActions" },
        },
      ],
    },
    {
      type: "group",
      heading: "Tools",
      items: [
        {
          name: "Claude Code skill",
          desc:
            "Teaches Claude Code to read and write Sidemark comment files. Writes the bundled skill to " +
            "~/.claude/skills/sidemark-comments/SKILL.md, replacing what's there.",
          // The skill is written outside the vault, to the user's home
          // directory, which mobile Obsidian has no way to reach.
          visible: options.desktopApp,
          render: (setting) => {
            setting.addButton((button) =>
              button.setButtonText("Install skill").onClick(() => {
                try {
                  new Notice("Skill installed: " + exportSkill());
                } catch (error) {
                  new Notice("Install failed: " + (error instanceof Error ? error.message : String(error)));
                }
              })
            );
          },
        },
        {
          name: "Convert tandem-comments blocks",
          desc:
            "Moves the comments and suggestions stored in tandem-comments blocks into Sidemark comment files, " +
            "then removes the blocks from your notes. Notes whose blocks can't be read are left untouched.",
          render: (setting) => {
            setting.addButton((button) =>
              button
                .setButtonText("Convert…")
                .setCta()
                .onClick(async () => {
                  button.setDisabled(true);
                  try {
                    await host.migrateTandem();
                  } finally {
                    button.setDisabled(false);
                  }
                })
            );
          },
        },
      ],
    },
  ];
}

export class SidemarkSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: SidemarkPlugin
  ) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return settingDefinitions(this.plugin, { desktopApp: Platform.isDesktop && Platform.isDesktopApp });
  }

  getControlValue(key: string): unknown {
    return readControl(this.plugin, key);
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    await writeControl(this.plugin, key, value);
    // Other rows' `visible` predicates read the settings just written.
    this.refreshDomState();
  }
}
