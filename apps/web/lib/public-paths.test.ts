import { describe, expect, it } from "vitest";
import { isPublicPath } from "./public-paths";

describe("isPublicPath", () => {
  it.each(["/login", "/auth/confirm", "/auth/error"])("%s is public", (p) => expect(isPublicPath(p)).toBe(true));
  it.each(["/authors", "/loginx", "/", "/projects/1"])("%s is not public", (p) => expect(isPublicPath(p)).toBe(false));
});
