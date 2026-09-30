import { describe, expect, it } from "vitest";
import { canonicalJson, inputHash } from "./hash";

describe("inputHash", () => {
  it("is independent of key order and ignores undefined", () => {
    expect(inputHash({ a: 1, b: { c: 2, d: undefined } })).toBe(inputHash({ b: { c: 2 }, a: 1 }));
  });
  it("changes when any value changes", () => {
    expect(inputHash({ prompt: "cat" })).not.toBe(inputHash({ prompt: "cats" }));
  });
  it("produces 64 hex chars", () => {
    expect(inputHash({ x: [1, "a"] })).toMatch(/^[0-9a-f]{64}$/);
  });
  it("canonicalJson sorts nested keys and keeps array order", () => {
    expect(canonicalJson({ z: [3, 1], a: { y: 1, b: 2 } })).toBe('{"a":{"b":2,"y":1},"z":[3,1]}');
  });
});
