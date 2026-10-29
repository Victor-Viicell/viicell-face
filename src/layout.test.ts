import { describe, expect, test } from "bun:test";
import {
  CHROME,
  letterbox,
  layoutFor,
  panelColumn,
  safeArea,
  type Layout,
  type LayoutState,
  type Rect,
} from "./layout";

/**
 * The acceptance for VF-010 is a set of window sizes, so the tests are those
 * sizes: at 640×360, 1280×720 and 1920×1080 the face keeps 16:9, nothing
 * overlaps it, and no control is clipped. Everything below is checked against
 * the rectangles, not against a screenshot no session could take.
 */

const open = (width = 320): LayoutState => ({ width, collapsed: false });
const folded = (width = 320): LayoutState => ({ width, collapsed: true });

const inside = (inner: Rect, outer: Rect): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const SIZES = [
  { width: 640, height: 360 },
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
] as const;

describe("layoutFor", () => {
  for (const size of SIZES) {
    describe(`${size.width}×${size.height}`, () => {
      const layout: Layout = layoutFor(size, open());

      test("reserves a column and gives the rest to the face", () => {
        expect(layout.panel.width).toBeGreaterThanOrEqual(CHROME.minPanel);
        expect(layout.panel.x).toBe(layout.stage.width);
        expect(layout.panel.x + layout.panel.width).toBe(size.width);
        expect(inside(layout.stage, { x: 0, y: 0, ...size })).toBe(true);
      });

      test("never puts the canvas under the panel", () => {
        expect(overlaps(layout.view, layout.panel)).toBe(false);
        expect(inside(layout.view, layout.stage)).toBe(true);
      });

      test("keeps 16:9 at a whole-number scale", () => {
        expect(layout.unit).toBeGreaterThanOrEqual(CHROME.minUnit);
        expect(layout.view.width).toBe(16 * layout.unit);
        expect(layout.view.height).toBe(9 * layout.unit);
        // The box fills the stage's short side: at most one unit of slack.
        expect(layout.view.width).toBeGreaterThan(size.width - layout.panel.width - CHROME.inset * 2 - 16);
      });

      test("leaves the face safe area uncovered and uncut", () => {
        expect(inside(layout.safe, layout.view)).toBe(true);
        expect(overlaps(layout.safe, layout.panel)).toBe(false);
        expect(overlaps(layout.safe, layout.content)).toBe(false);
      });

      test("does not clip the controls", () => {
        expect(layout.content.width).toBeGreaterThanOrEqual(CHROME.minContent);
        expect(inside(layout.content, layout.panel)).toBe(true);
      });

      test("folding hands the space back to the face", () => {
        const shut = layoutFor(size, folded());
        expect(shut.panel.width).toBe(CHROME.folded);
        expect(shut.stage.width).toBeGreaterThan(layout.stage.width);
        expect(shut.view.width).toBeGreaterThanOrEqual(layout.view.width);
        expect(overlaps(shut.view, shut.panel)).toBe(false);
      });
    });
  }

  test("keeps 16:9 in a window that is not 16:9", () => {
    const layout = layoutFor({ width: 1000, height: 1000 }, open());
    expect(layout.view.width / layout.view.height).toBeCloseTo(16 / 9, 2);
    expect(inside(layout.view, layout.stage)).toBe(true);
    expect(inside(layout.safe, layout.view)).toBe(true);
  });

  test("caps a remembered width that would swallow the window", () => {
    const layout = layoutFor({ width: 800, height: 600 }, open(4000));
    expect(layout.panel.width).toBeLessThanOrEqual(Math.round((800 - CHROME.inset * 2) * CHROME.share));
    expect(layout.stage.width).toBeGreaterThan(0);
    expect(layout.content.width).toBeGreaterThanOrEqual(CHROME.minContent);
  });

  test("honours a remembered width inside the limits", () => {
    expect(layoutFor({ width: 1920, height: 1080 }, open(300)).panel.width).toBe(300);
    // Below the floor the panel is drawn at the floor, not at the memory.
    expect(layoutFor({ width: 1920, height: 1080 }, open(10)).panel.width).toBe(CHROME.minPanel);
    // Above the ceiling likewise.
    expect(layoutFor({ width: 1920, height: 1080 }, open(9999)).panel.width).toBe(CHROME.maxPanel);
  });

  test("survives a window too small for the face", () => {
    const layout = layoutFor({ width: 120, height: 90 }, open());
    expect(layout.unit).toBe(0);
    expect(layout.view.width).toBeGreaterThan(0);
    expect(layout.view.height).toBeGreaterThan(0);
    expect(layout.panel.width).toBeLessThanOrEqual(120);
  });

  test("survives a nonsense size without a negative rectangle", () => {
    const layout = layoutFor({ width: 0, height: 0 }, open());
    for (const rect of [layout.panel, layout.stage, layout.view, layout.safe, layout.content]) {
      expect(rect.width).toBeGreaterThanOrEqual(0);
      expect(rect.height).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("panelColumn", () => {
  test("is the folded strip when folded, whatever is remembered", () => {
    expect(panelColumn(1920, folded(380))).toBe(CHROME.folded);
  });

  test("never grows past its share of a narrow window", () => {
    expect(panelColumn(700, open(420))).toBeLessThan(420);
    expect(panelColumn(1920, open(420))).toBe(CHROME.maxPanel);
  });
});

describe("letterbox", () => {
  test("centres the largest whole 16:9 box in the area", () => {
    const { view, unit } = letterbox({ x: 10, y: 20, width: 936, height: 696 });
    expect(unit).toBe(58);
    expect(view).toEqual({ x: 14, y: 20 + Math.floor((696 - 522) / 2), width: 928, height: 522 });
    expect(view.x).toBeGreaterThanOrEqual(10);
  });

  test("is empty for an empty area", () => {
    expect(letterbox({ x: 4, y: 4, width: 0, height: 100 }).view).toEqual({ x: 4, y: 4, width: 0, height: 0 });
  });
});

describe("safeArea", () => {
  test("is the canvas minus a margin on every side", () => {
    const safe = safeArea({ x: 0, y: 0, width: 800, height: 450 });
    expect(safe).toEqual({ x: 27, y: 27, width: 746, height: 396 });
    expect(inside(safe, { x: 0, y: 0, width: 800, height: 450 })).toBe(true);
  });

  test("collapses to nothing rather than going negative", () => {
    expect(safeArea({ x: 0, y: 0, width: 2, height: 2 })).toEqual({ x: 0, y: 0, width: 2, height: 2 });
  });
});
