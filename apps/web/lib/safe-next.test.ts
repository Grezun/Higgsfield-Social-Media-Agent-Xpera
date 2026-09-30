import { describe, expect, it } from "vitest";
import { safeNextPath } from "./safe-next";

describe("safeNextPath", () => {
  it("keeps same-site paths", () => {
    expect(safeNextPath("/projects/abc?x=1")).toBe("/projects/abc?x=1");
  });
  it("keeps encoded slashes as a same-site path", () => {
    expect(safeNextPath("/%2F%2Fevil.example")).toBe("/%2F%2Fevil.example");
  });
  it.each([null, undefined, "", "//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)", "projects", "/\t/evil.example", "/\n/evil.example", "/ /x", "/.//evil.example", "/..//evil.example", "/a/..//evil.example", "/%2e//evil.example", "/%2e%2e//evil.example"])(
    "falls back to / for %s",
    (raw) => {
      expect(safeNextPath(raw)).toBe("/");
    },
  );
});
