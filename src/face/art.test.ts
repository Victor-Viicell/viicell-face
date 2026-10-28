import { describe, expect, test } from "bun:test";
import { MOUTH, mouthBottomScale, mouthCornerShape, mouthOpenScale } from "./art";

/**
 * The corner cut has to reproduce the `LipCorner` ellipses of the reference
 * set. The four corners of the parameter space are the four references, so they
 * are the fixture: narrow/wide is `width`, happy/sad is `corner`.
 */
describe("mouthCornerShape", () => {
  test("matches the narrow happy sliver", () => {
    // MinHappinessWidth.svg: x 716.374..883.417, y 667.644..685.005.
    const shape = mouthCornerShape(0, 0);
    expect(shape.centre).toBeCloseTo(799.8955, 4);
    expect(shape.radiusX).toBeCloseTo(83.5215, 4);
    expect(shape.centreY - shape.radiusY).toBeCloseTo(667.644, 4);
    expect(shape.centreY + shape.radiusY).toBeCloseTo(685.005, 4);
  });

  test("matches the wide happy sliver", () => {
    // MaxHappinessWidth.svg: x 576.852..836.954, y 663.595..685.005.
    const shape = mouthCornerShape(1, 0);
    expect(shape.centre).toBeCloseTo(706.903, 4);
    expect(shape.radiusX).toBeCloseTo(130.051, 4);
    expect(shape.centreY - shape.radiusY).toBeCloseTo(663.595, 4);
    expect(shape.centreY + shape.radiusY).toBeCloseTo(685.005, 4);
  });

  test("matches the narrow sad disc", () => {
    // MinSadnessWidth.svg: x 716.374..883.417, y 663.595..766.931.
    const shape = mouthCornerShape(0, -1);
    expect(shape.centre).toBeCloseTo(799.8955, 4);
    expect(shape.radiusX).toBeCloseTo(83.5215, 4);
    expect(shape.centreY - shape.radiusY).toBeCloseTo(663.595, 4);
    expect(shape.centreY + shape.radiusY).toBeCloseTo(766.931, 4);
  });

  test("matches the wide sad disc", () => {
    // MaxSadnessWidth.svg: x 576.852..836.954, y 663.595..766.931.
    const shape = mouthCornerShape(1, -1);
    expect(shape.centre).toBeCloseTo(706.903, 4);
    expect(shape.radiusX).toBeCloseTo(130.051, 4);
    expect(shape.centreY - shape.radiusY).toBeCloseTo(663.595, 4);
    expect(shape.centreY + shape.radiusY).toBeCloseTo(766.931, 4);
  });

  test("opens the corner fully at the happiest pose", () => {
    // No cut at all: the upturned end of the upper line survives.
    expect(mouthCornerShape(0.5, 1).radiusY).toBeCloseTo(0, 6);
  });

  test("shrinks the sliver on the way from flat to happiest", () => {
    const flat = mouthCornerShape(0.5, 0);
    const half = mouthCornerShape(0.5, 0.5);
    expect(half.radiusY).toBeCloseTo(flat.radiusY / 2, 6);
    expect(half.centreY).toBeLessThan(flat.centreY);
  });

  test("grows from sliver to disc on the way to sad", () => {
    const flat = mouthCornerShape(0.5, 0);
    const sad = mouthCornerShape(0.5, -1);
    const half = mouthCornerShape(0.5, -0.5);
    expect(half.radiusY).toBeGreaterThan(flat.radiusY);
    expect(half.radiusY).toBeLessThan(sad.radiusY);
  });

  test("clamps values outside the rig's range", () => {
    expect(mouthCornerShape(-1, 2)).toEqual(mouthCornerShape(0, 1));
    expect(mouthCornerShape(2, -2)).toEqual(mouthCornerShape(1, -1));
  });
});

describe("MOUTH.rest", () => {
  test("is a neutral mouth between the two width references", () => {
    // Not the tiny Min mouth: the resting face needs visible lip corners, and a
    // frown is what narrows it to the Min reference.
    expect(MOUTH.rest.width).toBeGreaterThan(0.2);
    expect(MOUTH.rest.width).toBeLessThan(0.8);
    expect(MOUTH.rest.open).toBeGreaterThan(0);
    expect(MOUTH.rest.corner).toBeGreaterThan(0);
  });

  test("keeps the lower lip at the default width", () => {
    // Both the open and width references use a lower lip of factor 1, which sits
    // between the narrow (0.692) and wide (1.609) BottomWidth references.
    const bottom = MOUTH.bottomWidth.min +
      (MOUTH.bottomWidth.max - MOUTH.bottomWidth.min) * MOUTH.rest.bottomWidth;
    expect(bottom).toBeCloseTo(1, 6);
  });
});

describe("mouthOpenScale", () => {
  test("keeps the reference endpoints exact", () => {
    expect(mouthOpenScale(0)).toBeCloseTo(MOUTH.open.min, 6);
    expect(mouthOpenScale(1)).toBeCloseTo(MOUTH.open.max, 6);
  });

  test("opens the lower lip earlier than a linear scale would", () => {
    // The first third of the reference travel is hidden behind the gap, so a
    // linear map shows nothing until ~0.27. The eased map is well past that.
    const linear = MOUTH.open.min + (MOUTH.open.max - MOUTH.open.min) * 0.25;
    expect(mouthOpenScale(0.25)).toBeGreaterThan(linear);
    expect(mouthOpenScale(0.5)).toBeGreaterThan(0.8);
  });

  test("never closes as the pose opens", () => {
    let previous = -1;
    for (let pose = 0; pose <= 1; pose += 0.05) {
      const scale = mouthOpenScale(pose);
      expect(scale).toBeGreaterThanOrEqual(previous);
      previous = scale;
    }
  });
});

describe("mouthBottomScale", () => {
  test("reproduces both BottomWidth references when the mouth is open", () => {
    expect(mouthBottomScale(0, 1)).toBeCloseTo(0.692, 6);
    expect(mouthBottomScale(1, 1)).toBeCloseTo(1.609, 6);
  });

  test("keeps a wide lip inside the gap when the mouth is shut", () => {
    // The gap's corner arms only cover a lip up to the default width at rest.
    expect(mouthBottomScale(1, 0)).toBeCloseTo(1, 6);
    expect(mouthBottomScale(0.8, 0)).toBeCloseTo(1, 6);
  });

  test("fades the extra width in with the opening", () => {
    const quarter = mouthBottomScale(1, 0.25);
    const half = mouthBottomScale(1, 0.5);
    const full = mouthBottomScale(1, 1);
    expect(quarter).toBeGreaterThan(1);
    expect(quarter).toBeLessThan(half);
    expect(half).toBeLessThan(full);
    // A narrow lip has no extra width to fade in.
    expect(mouthBottomScale(0, 0.5)).toBeCloseTo(0.692, 6);
  });
});
