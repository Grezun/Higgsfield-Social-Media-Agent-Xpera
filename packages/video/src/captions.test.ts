import { describe, expect, it } from "vitest";
import { activeTokenIndex } from "./Captions";

const tokens = [{ fromMs: 100 }, { fromMs: 500 }, { fromMs: 900 }];

describe("activeTokenIndex", () => {
  it("is -1 before the first token", () => {
    expect(activeTokenIndex(tokens, 50)).toBe(-1);
  });
  it("switches exactly at a token start", () => {
    expect(activeTokenIndex(tokens, 100)).toBe(0);
    expect(activeTokenIndex(tokens, 500)).toBe(1);
  });
  it("keeps the previous token active through the gap before the next one", () => {
    expect(activeTokenIndex(tokens, 450)).toBe(0);
    expect(activeTokenIndex(tokens, 899)).toBe(1);
  });
  it("keeps the last token active afterwards", () => {
    expect(activeTokenIndex(tokens, 5000)).toBe(2);
  });
});
