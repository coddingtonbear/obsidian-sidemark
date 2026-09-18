import type { SettingDefinition, SettingDefinitionItem } from "obsidian";
import { describe, expect, it } from "vitest";
import {
  readControl,
  settingDefinitions,
  type SettingsControlKey,
  type SettingsHost,
  writeControl,
} from "../src/settings";
import { DEFAULT_SETTINGS, type SidemarkSettings } from "../src/settings-model";

class FakeHost implements SettingsHost {
  settings: SidemarkSettings = { ...DEFAULT_SETTINGS };
  override = "";
  patches: Partial<SidemarkSettings>[] = [];

  async updateSettings(patch: Partial<SidemarkSettings>): Promise<void> {
    this.patches.push(patch);
    this.settings = { ...this.settings, ...patch };
  }

  detectedAuthor(): string {
    return "detected";
  }

  authorOverride(): string {
    return this.override;
  }

  setAuthorOverride(value: string): void {
    this.override = value.trim();
  }

  async migrateTandem(): Promise<void> {}
}

type Items = SettingDefinitionItem<SettingsControlKey>[];

function groups(items: Items) {
  return items.flatMap((item) => ("type" in item && item.type === "group" ? [item] : []));
}

function rows(items: Items): SettingDefinition<SettingsControlKey>[] {
  return groups(items).flatMap((group) =>
    (group.items ?? []).flatMap((item) => ("type" in item && item.type === "page" ? [] : [item]))
  );
}

function row(items: Items, name: string): SettingDefinition<SettingsControlKey> {
  const found = rows(items).find((item) => item.name === name);
  if (!found) throw new Error(`No setting named ${name}`);
  return found;
}

function isVisible(item: SettingDefinition<SettingsControlKey>): boolean {
  const { visible } = item;
  return typeof visible === "function" ? visible() : visible !== false;
}

describe("settingDefinitions", () => {
  it("groups settings by where they show up", () => {
    const headings = groups(settingDefinitions(new FakeHost(), { desktopApp: true })).map((group) => group.heading);
    expect(headings).toEqual([undefined, "In the note", "In the sidebar", "Resolving and deleting", "Tools"]);
  });

  it("binds every control to a key the tab can read", () => {
    const host = new FakeHost();
    const controls = rows(settingDefinitions(host, { desktopApp: true })).flatMap((item) =>
      "control" in item && item.control ? [item.control.key] : []
    );
    expect(controls.length).toBeGreaterThan(0);
    for (const key of controls) expect(readControl(host, key), key).not.toBeUndefined();
  });

  it("offers the detected name as the placeholder for your name", () => {
    const item = row(settingDefinitions(new FakeHost(), { desktopApp: true }), "Your name");
    expect("control" in item && item.control?.type === "text" && item.control.placeholder).toBe("detected");
  });

  it("shows the resolved-by-default toggle only while resolved threads are kept", () => {
    const host = new FakeHost();
    const item = row(settingDefinitions(host, { desktopApp: true }), "Show resolved threads by default");
    expect(isVisible(item)).toBe(true);
    host.settings = { ...host.settings, resolveBehavior: "remove" };
    expect(isVisible(item)).toBe(false);
  });

  it("hides the Claude Code skill outside the desktop app", () => {
    const skill = (desktopApp: boolean) => row(settingDefinitions(new FakeHost(), { desktopApp }), "Claude Code skill");
    expect(isVisible(skill(true))).toBe(true);
    expect(isVisible(skill(false))).toBe(false);
  });
});

describe("readControl / writeControl", () => {
  it("keeps your name in the device-local override, not the synced settings", async () => {
    const host = new FakeHost();
    await writeControl(host, "authorName", "  Ada ");
    expect(host.override).toBe("Ada");
    expect(readControl(host, "authorName")).toBe("Ada");
    expect(host.patches).toEqual([]);
  });

  it("writes settings through updateSettings", async () => {
    const host = new FakeHost();
    await writeControl(host, "timestampDisplay", "relative");
    expect(host.settings.timestampDisplay).toBe("relative");
    expect(readControl(host, "timestampDisplay")).toBe("relative");
  });

  it("falls back to the default for a value of the wrong kind", async () => {
    const host = new FakeHost();
    host.settings = { ...host.settings, sidebarSortOrder: "newest" };
    await writeControl(host, "sidebarSortOrder", "sideways");
    expect(host.settings.sidebarSortOrder).toBe(DEFAULT_SETTINGS.sidebarSortOrder);
  });

  it("ignores keys that aren't bound to a control", async () => {
    const host = new FakeHost();
    await writeControl(host, "sidebarAdded", true);
    expect(host.patches).toEqual([]);
    expect(readControl(host, "authorColorOverrides")).toBeUndefined();
  });
});
