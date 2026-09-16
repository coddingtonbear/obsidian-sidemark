export const SIDECAR_SUFFIX = ".review.yaml";

/** MRSF §3.1: the co-located sidecar is the full document path plus `.review.yaml`. */
export function sidecarPathFor(notePath: string): string {
  return notePath + SIDECAR_SUFFIX;
}

/** Inverse of {@link sidecarPathFor}; null when `path` isn't a sidecar path. */
export function notePathFor(sidecarPath: string): string | null {
  if (!sidecarPath.endsWith(SIDECAR_SUFFIX)) return null;
  const notePath = sidecarPath.slice(0, -SIDECAR_SUFFIX.length);
  return notePath.endsWith(".md") ? notePath : null;
}
