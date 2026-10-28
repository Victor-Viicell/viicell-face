import { describe, expect, test } from "bun:test";
import {
  blurGrid,
  brightnessGrid,
  gainGrid,
  liftImage,
  luminance,
  maxGain,
  sampleGrid,
} from "./lowlight";

/** An RGBA image filled with one grey level. */
function frame(width: number, height: number, grey: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    data.set([grey, grey, grey, 255], pixel * 4);
  }
  return data;
}

describe("luminance", () => {
  test("reads black and white", () => {
    expect(luminance(0, 0, 0)).toBe(0);
    expect(luminance(255, 255, 255)).toBe(255);
  });

  test("weighs green above red above blue", () => {
    expect(luminance(0, 255, 0)).toBeGreaterThan(luminance(255, 0, 0));
    expect(luminance(255, 0, 0)).toBeGreaterThan(luminance(0, 0, 255));
  });
});

describe("brightnessGrid", () => {
  test("reads each cell's brightness", () => {
    const data = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
    expect(Array.from(brightnessGrid(data, 2))).toEqual([0, luminance(255, 255, 255)]);
  });
});

describe("blurGrid", () => {
  test("spreads a bright cell into its neighbours", () => {
    const grid = new Float32Array(9);
    grid[4] = 90;
    blurGrid(grid, 3, 3, 1);

    expect(grid[4]).toBeLessThan(90);
    expect(grid[1]).toBeGreaterThan(0);
    // A 3×3 window at the top-middle sees the bright cell in 6 of its 9 cells.
    expect(grid[1]).toBeCloseTo(15, 6);
  });

  test("leaves a flat grid flat", () => {
    const grid = new Float32Array(16).fill(42);
    blurGrid(grid, 4, 4, 2);
    for (const value of grid) {
      expect(value).toBeCloseTo(42, 6);
    }
  });
});

describe("gainGrid", () => {
  test("lifts shadows, clamps the gain, and leaves lit areas alone", () => {
    const gains = gainGrid(new Float32Array([0, 60, 132, 200]));
    // The floor keeps a black cell from dividing by zero.
    expect(gains[0]).toBe(3);
    expect(gains[1]).toBeCloseTo(132 / 60, 5);
    expect(gains[2]).toBe(1);
    expect(gains[3]).toBe(1);
  });

  test("reports the strongest lift in the grid", () => {
    expect(maxGain(new Float32Array([1, 1.4, 2]))).toBe(2);
    expect(maxGain(new Float32Array([1, 1]))).toBe(1);
  });
});

describe("sampleGrid", () => {
  test("interpolates between cells", () => {
    const grid = new Float32Array([0, 10, 20, 30]);
    expect(sampleGrid(grid, 2, 2, 0, 0)).toBe(0);
    expect(sampleGrid(grid, 2, 2, 0.5, 0)).toBeCloseTo(5);
    expect(sampleGrid(grid, 2, 2, 0.5, 0.5)).toBeCloseTo(15);
  });

  test("clamps outside the grid", () => {
    const grid = new Float32Array([0, 10]);
    expect(sampleGrid(grid, 2, 1, -4, 0)).toBe(0);
    expect(sampleGrid(grid, 2, 1, 9, 0)).toBe(10);
  });
});

describe("liftImage", () => {
  test("brightens a dark frame", () => {
    const data = frame(4, 4, 30);
    const gains = gainGrid(blurGrid(brightnessGrid(data, 16), 4, 4, 2));

    expect(maxGain(gains)).toBeGreaterThan(2);
    expect(liftImage(data, 4, 4, gains, 4, 4)).toBe(true);
    expect(data[0]).toBe(90);
  });

  test("leaves a well-lit frame untouched", () => {
    const data = frame(4, 4, 200);
    const gains = gainGrid(blurGrid(brightnessGrid(data, 16), 4, 4, 2));

    expect(liftImage(data, 4, 4, gains, 4, 4)).toBe(false);
    expect(data[0]).toBe(200);
  });

  test("lifts the shadow side without touching the lit side", () => {
    const width = 8;
    const height = 8;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const grey = x < width / 2 ? 30 : 200;
        data.set([grey, grey, grey, 255], (y * width + x) * 4);
      }
    }

    const gains = gainGrid(blurGrid(brightnessGrid(data, width * height), width, height, 2));
    expect(liftImage(data, width, height, gains, width, height)).toBe(true);

    // Far corners: the dark side came up, the lit side stayed where it was.
    expect(data[0]).toBeGreaterThan(30);
    expect(data[(width - 1) * 4]).toBe(200);
  });
});
