import { describe, expect, test } from "bun:test";
import { statusLine, type StatusSnapshot } from "./hud";

/**
 * The line is the only sentence the app says about its own health on every
 * screen, so the tests pin whole strings, not fragments: a chip row replacing
 * it (VF-011) must keep every field, and a reordered field is a visible change.
 */

const base: StatusSnapshot = {
  tracking: false,
  device: { label: "Upright Camera", path: "/dev/video10" },
  width: 1280,
  height: 720,
  pixelFormat: "YUYV",
  fps: 29.97,
  framesReceived: 1234,
  framesDropped: 3,
  gaze: { label: "center", source: "monitor" },
  keysGlobal: true,
  mic: null,
  face: { kind: "off" },
  lowLightGain: 0,
};

const line = (patch: Partial<StatusSnapshot>): string => statusLine({ ...base, ...patch });

describe("status line", () => {
  test("manual mode names the device, the format and the cursor source", () => {
    expect(line({})).toBe(
      "mode manual · Upright Camera · /dev/video10 · 1280×720 YUYV · " +
        "30 fps · 1234 in · 3 dropped · eyes center·monitor · keys global",
    );
  });

  test("the measured rate is rounded, the format is not", () => {
    expect(line({ fps: 24.5 })).toContain("25 fps");
    expect(line({ fps: 59.94 })).toContain("60 fps");
  });

  test("window-only keys say window", () => {
    expect(line({ keysGlobal: false })).toContain("keys window");
  });

  test("tracking mode replaces the cursor source with the camera reading", () => {
    const text = line({
      tracking: true,
      gaze: { label: "top left", source: "monitor" },
      face: { kind: "info", width: 640, height: 480, frames: 700, failed: false },
    });
    expect(text).toContain("mode track");
    expect(text).toContain("eyes camera·top left");
    expect(text).not.toContain("·monitor");
    expect(text).toContain("face 640×480 700 fr");
  });

  test("a failed tracking camera says off instead of a frame count", () => {
    const text = line({
      tracking: true,
      face: { kind: "info", width: 640, height: 480, frames: 0, failed: true },
    });
    expect(text).toContain("face 640×480 off");
    expect(text).not.toContain("fr");
  });

  test("a camera that has not opened yet says starting", () => {
    expect(line({ tracking: true, face: { kind: "starting" } })).toContain("face starting");
  });

  test("a failed status poll says `?`, and does not claim a lift", () => {
    const text = line({ tracking: true, face: { kind: "unknown" }, lowLightGain: 1.8 });
    expect(text).toContain("face ?");
    expect(text).not.toContain("lift");
  });

  test("the low-light lift only appears when it did something", () => {
    const info: StatusSnapshot["face"] = {
      kind: "info",
      width: 640,
      height: 480,
      frames: 12,
      failed: false,
    };
    expect(line({ tracking: true, face: info, lowLightGain: 1.05 })).not.toContain("lift");
    expect(line({ tracking: true, face: info, lowLightGain: 1.66 })).toContain("lift ×1.7");
    // Outside tracking mode the stage never ran, so there is nothing to report.
    expect(line({ face: info, lowLightGain: 1.66 })).not.toContain("lift");
  });

  test("the microphone says waiting or off, and says nothing when live", () => {
    expect(line({ mic: "waiting" })).toContain("mic waiting");
    expect(line({ mic: "off" })).toContain("mic off");
    expect(line({ mic: null })).not.toContain("mic");
  });

  test("the notes keep their order: mic before the camera", () => {
    const text = line({
      tracking: true,
      mic: "waiting",
      face: { kind: "starting" },
    });
    expect(text.endsWith("keys global · mic waiting · face starting")).toBe(true);
  });
});
