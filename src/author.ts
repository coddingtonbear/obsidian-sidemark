/**
 * The author label on new comments is device-local: it's kept in the vault's
 * localStorage rather than the synced plugin data, so people sharing a vault
 * each keep their own name. Resolution order: the manual override, then the
 * operating-system username (desktop only), then a generic fallback.
 */
import { Platform } from "obsidian";

export const AUTHOR_OVERRIDE_KEY = "sidemark:author-name-override";

/** Used when neither an override nor an OS username is available (e.g. on mobile). */
export const FALLBACK_AUTHOR = "Me";

// `require` is provided by Obsidian's desktop (Electron) runtime and absent on mobile.
declare const require: ((module: string) => unknown) | undefined;

export function detectOsUsername(): string | null {
  try {
    if (Platform.isDesktop && Platform.isDesktopApp && typeof require === "function") {
      const os = require("os") as { userInfo?: () => { username?: string } };
      const name = os.userInfo?.().username?.trim();
      return name ? name : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function resolveAuthorName(override: string | null | undefined, osUsername: string | null): string {
  const trimmed = override?.trim();
  if (trimmed) return trimmed;
  return osUsername ?? FALLBACK_AUTHOR;
}
