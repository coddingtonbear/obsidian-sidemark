import { describe, expect, it } from "vitest";
import { selectedTextHash } from "../src/hash";

describe("selectedTextHash", () => {
  it("matches the SHA-256 hex digest of the UTF-8 text", async () => {
    expect(await selectedTextHash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});
