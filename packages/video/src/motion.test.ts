import { describe, expect, it } from "vitest";
import { enterStyle, motionTransform, popScale, TRANSITION_FRAMES, typedLength } from "./motion";

describe("motionTransform", () => {
  it("zooms in from 1 to 1.15 across the clip", () => {
    expect(motionTransform("zoom_in", 0, 90)).toBe("scale(1.0000)");
    expect(motionTransform("zoom_in", 89, 90)).toBe("scale(1.1500)");
  });
  it("pans left from +4% to -4%", () => {
    expect(motionTransform("pan_left", 0, 60)).toBe("scale(1.12) translateX(4.000%)");
    expect(motionTransform("pan_left", 59, 60)).toBe("scale(1.12) translateX(-4.000%)");
  });
  it("returns none for no motion", () => {
    expect(motionTransform("none", 10, 60)).toBe("none");
  });
});

describe("enterStyle", () => {
  it("fades from 0 to 1 over TRANSITION_FRAMES", () => {
    expect(enterStyle("fade", 0)).toEqual({ opacity: 0 });
    expect(enterStyle("fade", TRANSITION_FRAMES)).toEqual({ opacity: 1 });
  });
  it("whips in from the right", () => {
    expect(enterStyle("whip", 0)).toEqual({ transform: "translateX(100.00%)" });
    expect(enterStyle("whip", TRANSITION_FRAMES)).toEqual({ transform: "translateX(0.00%)" });
  });
  it("does nothing on cut", () => {
    expect(enterStyle("cut", 0)).toEqual({});
  });
});

describe("overlay helpers", () => {
  it("popScale goes from 0.6 to 1", () => {
    expect(popScale(0)).toBeCloseTo(0.6);
    expect(popScale(8)).toBeCloseTo(1);
  });
  it("typedLength reveals by code point, including Hebrew", () => {
    expect(typedLength("שלום", 0)).toBe(1);
    expect(typedLength("שלום", 100)).toBe(4);
  });
});
