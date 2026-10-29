import { describe, expect, test } from "bun:test";
import { overlayPosition } from "./look_overlay";

describe("overlayPosition", () => {
  test("maps a monitor point to percentages of the layer", () => {
    expect(overlayPosition({ u: 0.25, v: 0.75 })).toEqual({ left: "25%", top: "75%" });
  });

  test("puts the corners on the edges", () => {
    expect(overlayPosition({ u: 0, v: 0 })).toEqual({ left: "0%", top: "0%" });
    expect(overlayPosition({ u: 1, v: 1 })).toEqual({ left: "100%", top: "100%" });
  });

  test("keeps an out-of-range or broken point on the layer", () => {
    expect(overlayPosition({ u: 1.2, v: -0.3 })).toEqual({ left: "100%", top: "0%" });
    expect(overlayPosition({ u: Number.NaN, v: 0.5 })).toEqual({ left: "0%", top: "50%" });
  });
});
