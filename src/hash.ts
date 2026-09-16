/**
 * MRSF `selected_text_hash`: lowercase hex SHA-256 of the UTF-8 text. MRSF's own
 * `computeHash` uses `node:crypto`, which isn't available on mobile, so this
 * uses Web Crypto instead.
 */
export async function selectedTextHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
