import { describe, expect, test } from "bun:test";
import { FACE, MOCHA, rgb } from "./palette";

describe("MOCHA", () => {
  test("every entry is a lowercase hex colour", () => {
    for (const [name, value] of Object.entries(MOCHA)) {
      expect(value, name).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("FACE", () => {
  /**
   * The brow and cheek slashes are eyelids that must vanish at rest. They are
   * painted with the backdrop's own two colours, so if one of these drifts the
   * face grows dark bars that were never in the artwork.
   */
  test("the resting lines match the backdrop", () => {
    expect(FACE.line.top).toBe(FACE.backdrop.inner);
    expect(FACE.line.bottom).toBe(FACE.backdrop.outer);
  });

  test("the eye accents stay in the palette", () => {
    const values = new Set<string>(Object.values(MOCHA));
    expect(values.has(FACE.shell.middle)).toBe(true);
    expect(values.has(FACE.pupil.middle)).toBe(true);
    expect(values.has(FACE.iris.rim)).toBe(true);
    expect(values.has(FACE.mouth.cap)).toBe(true);
  });
});

describe("rgb", () => {
  test("normalises a hex colour for a shader uniform", () => {
    expect(rgb("#11111b")).toEqual([17 / 255, 17 / 255, 27 / 255]);
    expect(rgb("#ffffff")).toEqual([1, 1, 1]);
    expect(rgb("#000000")).toEqual([0, 0, 0]);
  });
});
