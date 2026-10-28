import { describe, expect, test } from "bun:test";
import { FULL_CROP, boxOf, easeCrop, frameAround } from "./crop";

const close = (value: number, expected: number) => expect(value).toBeCloseTo(expected, 6);

describe("boxOf", () => {
  test("boxes every point", () => {
    const box = boxOf([
      { x: 0.2, y: 0.3 },
      { x: 0.6, y: 0.4 },
      { x: 0.4, y: 0.8 },
    ]);

    expect(box).not.toBeNull();
    close(box!.x, 0.2);
    close(box!.y, 0.3);
    close(box!.w, 0.4);
    close(box!.h, 0.5);
  });

  test("has no box without a spread of points", () => {
    expect(boxOf([])).toBeNull();
    expect(
      boxOf([
        { x: 0.5, y: 0.5 },
        { x: 0.5, y: 0.5 },
      ]),
    ).toBeNull();
  });
});

describe("frameAround", () => {
  test("pads the box and widens it to the preview's aspect", () => {
    // 0.4 tall and 0.2 wide, padded by 6% on each side: 0.448 tall.
    const crop = frameAround({ x: 0.4, y: 0.3, w: 0.2, h: 0.4 }, 1);

    close(crop.h, 0.448);
    close(crop.w, 0.448);
    close(crop.x + crop.w / 2, 0.5);
    close(crop.y + crop.h / 2, 0.5);
  });

  test("keeps a distant face from being blown up", () => {
    const crop = frameAround({ x: 0.48, y: 0.48, w: 0.04, h: 0.04 }, 1);

    close(crop.w, 0.4);
    close(crop.x, 0.3);
    close(crop.y, 0.3);
  });

  test("stays inside the frame, keeping the aspect", () => {
    // The padded box runs off the right edge, so the crop is pushed back in.
    const crop = frameAround({ x: 0.9, y: 0.1, w: 0.2, h: 0.5 }, 1);

    close(crop.w, 0.56);
    close(crop.h, 0.56);
    close(crop.x, 0.44);
    close(crop.y, 0.07);
  });

  test("takes the preview's aspect in frame units, not pixels", () => {
    // A 4:3 capture previewed at 16:9 makes the crop 1.333 wider than tall.
    const aspect = (16 / 9) * (480 / 640);
    const crop = frameAround({ x: 0.4, y: 0.3, w: 0.2, h: 0.4 }, aspect);

    close(crop.w / crop.h, aspect);
  });
});

describe("easeCrop", () => {
  test("moves partway and keeps the aspect", () => {
    const target = { x: 0.3, y: 0.3, w: 0.4, h: 0.4 };
    const next = easeCrop(FULL_CROP, target, 0.11);

    expect(next.w).toBeGreaterThan(target.w);
    expect(next.w).toBeLessThan(FULL_CROP.w);
    close(next.w / next.h, 1);
    expect(next.x).toBeGreaterThan(0);
    expect(next.x).toBeLessThan(target.x);
  });

  test("snaps when there is no time to ease", () => {
    const target = { x: 0.3, y: 0.3, w: 0.4, h: 0.4 };

    expect(easeCrop(FULL_CROP, target, 0)).toEqual(target);
  });
});
