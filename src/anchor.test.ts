import { describe, expect, test } from "bun:test";
import { ANCHOR_POINTS, fromOrigin } from "./anchor";

describe("fromOrigin", () => {
  test("is the identity at the middle of the screen", () => {
    expect(fromOrigin({ u: 0.2, v: 0.8 }, ANCHOR_POINTS.center)).toEqual({ u: 0.2, v: 0.8 });
  });

  test("reads the origin itself as straight ahead", () => {
    const point = fromOrigin(ANCHOR_POINTS.topLeft, ANCHOR_POINTS.topLeft);
    expect(point.u).toBe(0.5);
    expect(point.v).toBe(0.5);
  });

  test("sees the middle below and to the right from the top left", () => {
    const point = fromOrigin({ u: 0.5, v: 0.5 }, ANCHOR_POINTS.topLeft);
    expect(point.u).toBeCloseTo(0.75);
    expect(point.v).toBeCloseTo(0.75);
  });

  test("sees the middle above and to the left from the bottom right", () => {
    const point = fromOrigin({ u: 0.5, v: 0.5 }, ANCHOR_POINTS.bottomRight);
    expect(point.u).toBeCloseTo(0.25);
    expect(point.v).toBeCloseTo(0.25);
  });
});
