import { describe, expect, it } from "vitest";
import { signInRedirectUrl } from "./site-url";

describe("signInRedirectUrl", () => {
  it("is null when missing", () => {
    expect(signInRedirectUrl(undefined)).toBeNull();
    expect(signInRedirectUrl("")).toBeNull();
  });
  it("strips a trailing slash", () => {
    expect(signInRedirectUrl("http://localhost:3000/")).toBe("http://localhost:3000/auth/confirm");
    expect(signInRedirectUrl("http://localhost:3000")).toBe("http://localhost:3000/auth/confirm");
  });
});
