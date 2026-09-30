import { describe, expect, it } from "vitest";
import { safeNextPath } from "./safe-next";

describe("safeNextPath", () => {
  it("keeps same-site paths", () => {
    expect(safeNextPath("/projects/abc?x=1")).toBe("/projects/abc?x=1");
  });
  it.each([null, undefined, "", "//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)", "projects"])(
    "falls back to / for %s",
    (raw) => {
      expect(safeNextPath(raw)).toBe("/");
    },
  );
});
