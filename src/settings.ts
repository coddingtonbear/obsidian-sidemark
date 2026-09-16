import { type App, PluginSettingTab, Setting } from "obsidian";
import type SidemarkPlugin from "./main";
import { DEFAULT_SETTINGS, type SidebarSortOrder, type SubmitShortcut, type TimestampDisplay } from "./settings-model";
import type { ResolveBehavior } from "./mutations";

export class SidemarkSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: SidemarkPlugin
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const plugin = this.plugin;
    const settings = plugin.settings;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Your name")
      .setDesc("Shown on comments you write from this device. Stored on this device only, so people sharing a vault keep their own names.")
      .addText((text) =>
        text
          .setPlaceholder(plugin.detectedAuthor())
          .setValue(plugin.authorOverride())
          .onChange((value) => plugin.setAuthorOverride(value))
      );

    new Setting(containerEl).setName("Appearance").setHeading();
    new Setting(containerEl)
      .setName("Highlight color")
      .addColorPicker((picker) =>
        picker.setValue(settings.highlightColor).onChange((value) => void plugin.updateSettings({ highlightColor: value }))
      )
      .addExtraButton((button) =>
        button
          .setIcon("rotate-ccw")
          .setTooltip("Reset")
          .onClick(async () => {
            await plugin.updateSettings({ highlightColor: DEFAULT_SETTINGS.highlightColor });
            this.display();
          })
      );
    new Setting(containerEl)
      .setName("Highlight opacity")
      .addSlider((slider) =>
        slider
          .setLimits(10, 80, 5)
          .setValue(settings.highlightOpacity)
          .setDynamicTooltip()
          .onChange((value) => void plugin.updateSettings({ highlightOpacity: value }))
      );
    new Setting(containerEl)
      .setName("Color author names")
      .setDesc("Give each author a consistent color in the sidebar.")
      .addToggle((toggle) =>
        toggle.setValue(settings.colorAuthorNames).onChange((value) => void plugin.updateSettings({ colorAuthorNames: value }))
      );
    new Setting(containerEl)
      .setName("Timestamps")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ full: "Full", compact: "Compact", relative: "Relative (5 minutes ago)", hidden: "Hidden" })
          .setValue(settings.timestampDisplay)
          .onChange((value) => void plugin.updateSettings({ timestampDisplay: value as TimestampDisplay }))
      );
    new Setting(containerEl)
      .setName("Sort threads by")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ document: "Position in note", newest: "Newest activity", oldest: "Oldest activity" })
          .setValue(settings.sidebarSortOrder)
          .onChange((value) => void plugin.updateSettings({ sidebarSortOrder: value as SidebarSortOrder }))
      );

    new Setting(containerEl).setName("Behavior").setHeading();
    new Setting(containerEl)
      .setName("When a thread is resolved")
      .setDesc("Keeping resolved threads leaves them in the comment file as history; they never appear in the note itself.")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ keep: "Keep it as resolved", remove: "Delete it" })
          .setValue(settings.resolveBehavior)
          .onChange(async (value) => {
            await plugin.updateSettings({ resolveBehavior: value as ResolveBehavior });
            this.display();
          })
      );
    if (settings.resolveBehavior === "keep") {
      new Setting(containerEl)
        .setName("Show resolved threads by default")
        .addToggle((toggle) =>
          toggle
            .setValue(settings.showResolvedByDefault)
            .onChange((value) => void plugin.updateSettings({ showResolvedByDefault: value }))
        );
    }
    new Setting(containerEl)
      .setName("Send comments with")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ enter: "Enter (Shift+Enter for a new line)", "mod-enter": "Cmd/Ctrl+Enter" })
          .setValue(settings.submitShortcut)
          .onChange((value) => void plugin.updateSettings({ submitShortcut: value as SubmitShortcut }))
      );
    new Setting(containerEl)
      .setName("Confirm before deleting")
      .addToggle((toggle) =>
        toggle
          .setValue(settings.confirmDestructiveActions)
          .onChange((value) => void plugin.updateSettings({ confirmDestructiveActions: value }))
      );

    new Setting(containerEl).setName("Tandem Comments").setHeading();
    new Setting(containerEl)
      .setName("Convert Tandem Comments")
      .setDesc(
        "Moves the comments and suggestions stored in tandem-comments blocks into Sidemark comment files, " +
          "then removes the blocks from your notes. Notes whose blocks can't be read are left untouched."
      )
      .addButton((button) =>
        button
          .setButtonText("Convert…")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            try {
              await plugin.migrateTandem();
            } finally {
              button.setDisabled(false);
            }
          })
      );
  }
}
