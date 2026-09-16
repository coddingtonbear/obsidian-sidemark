import { StateField } from "@codemirror/state";

/** Minimal stand-ins for the parts of the Obsidian API that load in unit tests. */
export interface MockFileInfo {
  file: { path: string; extension: string } | null;
}

export const editorInfoField = StateField.define<MockFileInfo>({
  create: () => ({ file: null }),
  update: (value) => value,
});
