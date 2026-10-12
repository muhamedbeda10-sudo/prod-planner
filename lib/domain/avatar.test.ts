import { describe, expect, it } from "vitest";
import { AVATAR_MAX_BYTES, avatarColor, avatarFileError, initials } from "./avatar";

describe("the round button's initials", () => {
  it("take the first and last name's first letters", () => {
    expect(initials("Muhamed Beda")).toBe("MB");
    expect(initials("  ahmed  ali  hassan ")).toBe("AH");
  });
  it("take two letters of a single name, and say ? for none", () => {
    expect(initials("Sayed")).toBe("SA");
    expect(initials("   ")).toBe("?");
  });
  it("keep a name in Arabic whole letters", () => {
    expect(initials("محمد بدة")).toBe("مب");
  });
});

describe("an account's colour", () => {
  it("is the same every time for the same account", () => {
    expect(avatarColor(7)).toBe(avatarColor(7));
    expect(avatarColor(7)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("what may be a photo", () => {
  it("takes a JPEG, PNG or WebP up to the limit", () => {
    expect(avatarFileError("image/jpeg", 40_000)).toBeNull();
    expect(avatarFileError("image/png", AVATAR_MAX_BYTES)).toBeNull();
    expect(avatarFileError("image/webp", 1)).toBeNull();
  });
  it("refuses an SVG — it can carry script — and anything not a picture", () => {
    expect(avatarFileError("image/svg+xml", 1000)).toMatch(/JPEG, PNG or WebP/);
    expect(avatarFileError("application/pdf", 1000)).toMatch(/JPEG, PNG or WebP/);
  });
  it("refuses an empty file and one over the limit", () => {
    expect(avatarFileError("image/jpeg", 0)).toMatch(/empty/);
    expect(avatarFileError("image/jpeg", AVATAR_MAX_BYTES + 1)).toMatch(/too large/);
  });
});
