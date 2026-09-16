import { type App, TFile } from "obsidian";
import type { SidecarIO } from "./store";

/**
 * Sidecar file access through the vault API, falling back to the raw adapter
 * for any file the vault hasn't indexed.
 */
export class VaultSidecarIO implements SidecarIO {
  constructor(private readonly app: App) {}

  private file(path: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  }

  async read(path: string): Promise<string | null> {
    const file = this.file(path);
    if (file) return this.app.vault.read(file);
    const adapter = this.app.vault.adapter;
    return (await adapter.exists(path)) ? adapter.read(path) : null;
  }

  async write(path: string, content: string): Promise<void> {
    const file = this.file(path);
    if (file) {
      await this.app.vault.modify(file, content);
      return;
    }
    if (await this.app.vault.adapter.exists(path)) {
      await this.app.vault.adapter.write(path, content);
      return;
    }
    await this.app.vault.create(path, content);
  }

  async remove(path: string): Promise<void> {
    const file = this.file(path);
    if (file) {
      // Respects the user's "deleted files" preference (system trash, .trash, or permanent).
      await this.app.fileManager.trashFile(file);
      return;
    }
    if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
  }

  exists(path: string): Promise<boolean> {
    return this.app.vault.adapter.exists(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const file = this.file(from);
    if (file) await this.app.vault.rename(file, to);
    else await this.app.vault.adapter.rename(from, to);
  }
}
