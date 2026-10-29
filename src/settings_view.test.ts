import { describe, expect, test } from "bun:test";
import { GAZE_ANCHORS } from "./anchor";
import { DEFAULT_SETTINGS, LIMITS, SettingsStore, mergeSettings } from "./settings";
import {
  FPS_PRESETS,
  ORIGIN_ORDER,
  OUTPUT_PRESETS,
  fpsChoices,
  originChoices,
  outputChoices,
  panelView,
  parseSize,
  sizeLabel,
} from "./settings_view";

describe("the size picker", () => {
  test("offers the presets, largest first, all sixteen-by-nine", () => {
    const choices = outputChoices(1280, 720);
    expect(choices.map((choice) => choice.label)).toEqual([
      "1920×1080",
      "1280×720",
      "960×540",
      "640×360",
    ]);
    for (const choice of choices) {
      expect(choice.width / choice.height).toBeCloseTo(16 / 9, 2);
    }
  });

  test("puts a saved size that is not a preset first, so the control never lies", () => {
    const choices = outputChoices(800, 450);
    expect(choices[0]).toEqual({ width: 800, height: 450, label: "800×450" });
    expect(choices).toHaveLength(OUTPUT_PRESETS.length + 1);
  });

  test("does not double an exact preset", () => {
    const choices = outputChoices(1920, 1080);
    expect(choices).toHaveLength(OUTPUT_PRESETS.length);
  });
});

describe("the rate picker", () => {
  test("offers the presets, fastest first", () => {
    expect(fpsChoices(30)).toEqual([...FPS_PRESETS]);
    expect(fpsChoices(30)).toEqual([60, 30, 24, 15]);
  });

  test("keeps an odd saved rate in its place", () => {
    expect(fpsChoices(144)).toEqual([144, 60, 30, 24, 15]);
  });
});

describe("parseSize", () => {
  test("reads the label the picker writes", () => {
    expect(parseSize("1280×720")).toEqual({ width: 1280, height: 720 });
    expect(parseSize(" 1920x1080 ")).toEqual({ width: 1920, height: 1080 });
  });

  test("rounds an odd size down to the even one YUYV needs", () => {
    expect(parseSize("1001x777")).toEqual({ width: 1000, height: 776 });
    expect(parseSize("1281x721")).toEqual({ width: 1280, height: 720 });
  });

  test("clamps out-of-range sizes instead of refusing them", () => {
    expect(parseSize("4000x4000")).toEqual({
      width: LIMITS.output.maxWidth,
      height: LIMITS.output.maxHeight,
    });
    expect(parseSize("10x10")).toEqual({
      width: LIMITS.output.minWidth,
      height: LIMITS.output.minHeight,
    });
  });

  test("refuses anything that is not a size", () => {
    for (const text of ["", "big", "1280", "1280×", "×720", "1280×720 slow", "-1×-1"]) {
      expect(parseSize(text)).toBeNull();
    }
  });
});

describe("the store is still the gate", () => {
  test("a parsed size survives a round trip through the store unchanged", () => {
    const store = new SettingsStore(null);
    const size = parseSize("1001x777");
    expect(size).not.toBeNull();
    store.set({ output: size! });
    expect(store.value("output")).toEqual({ width: 1000, height: 776, fps: 30 });
  });

  test("a size written around the panel is clamped before anything reads it", () => {
    const saved = mergeSettings({ output: { width: 4001, height: 9, fps: 500 } });
    expect(saved.output).toEqual({ width: 1920, height: 90, fps: 120 });
  });
});

describe("the origin grid", () => {
  test("has one button per anchor the keys and the store know", () => {
    const choices = originChoices();
    expect(choices.map((choice) => choice.anchor)).toEqual([...ORIGIN_ORDER]);
    expect(choices).toHaveLength(GAZE_ANCHORS.length);
    for (const anchor of GAZE_ANCHORS) {
      expect(choices.some((choice) => choice.anchor === anchor)).toBe(true);
    }
  });

  test("labels come from the shared table, not a second copy", () => {
    expect(originChoices().map((choice) => choice.label)).toEqual([
      "top left",
      "top right",
      "centre",
      "bottom left",
      "bottom right",
    ]);
  });
});

describe("panelView", () => {
  test("reads the defaults", () => {
    expect(panelView(DEFAULT_SETTINGS)).toEqual({
      size: "1280×720",
      fps: "30",
      origin: "center",
      startTrack: false,
    });
  });

  test("follows the store, so a restart paints what was saved", () => {
    const saved = mergeSettings({
      output: { width: 1920, height: 1080, fps: 60 },
      gazeOrigin: "bottomRight",
      startMode: "track",
    });
    expect(panelView(saved)).toEqual({
      size: "1920×1080",
      fps: "60",
      origin: "bottomRight",
      startTrack: true,
    });
  });

  test("the label is the same text the picker parses back", () => {
    const view = panelView(DEFAULT_SETTINGS);
    expect(parseSize(view.size)).toEqual({ width: 1280, height: 720 });
    expect(view.size).toBe(sizeLabel(1280, 720));
  });
});
