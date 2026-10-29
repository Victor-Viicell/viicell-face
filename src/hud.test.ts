import { describe, expect, test } from "bun:test";
import { inputDenied } from "./errors";
import {
  FPS_WARN_BELOW,
  statusChips,
  type Chip,
  type ChipKey,
  type StatusSnapshot,
} from "./hud";

/**
 * The row is the only thing the app says about its own health on every screen,
 * so the tests pin the labels, the order and the state of every chip: a chip
 * that changes order reflows the foot, and a warning that loses its `warn`
 * state is invisible in a 295 px column.
 *
 * The tooltips are pinned by content too — they are the whole point of the row
 * (each one names the number's source or the command that fixes it), and they
 * are the only place several fields appear at all.
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

const ORDER: ChipKey[] = ["mode", "device", "fps", "dropped", "mic", "face", "keys", "origin"];

const chips = (patch: Partial<StatusSnapshot>): Chip[] => statusChips({ ...base, ...patch });

const chip = (patch: Partial<StatusSnapshot>, key: ChipKey): Chip => {
  const found = chips(patch).find((c) => c.key === key);
  if (found === undefined) throw new Error(`no ${key} chip`);
  return found;
};

const label = (patch: Partial<StatusSnapshot>, key: ChipKey): string => chip(patch, key).label;
const tooltip = (patch: Partial<StatusSnapshot>, key: ChipKey): string => chip(patch, key).tooltip;

describe("the status row", () => {
  test("has eight chips, in one fixed order, whatever the state", () => {
    expect(chips({}).map((c) => c.key)).toEqual(ORDER);
    // The count and the order are what stop the row jumping under the reader.
    expect(
      chips({
        tracking: true,
        mic: "off",
        face: { kind: "starting" },
        keysGlobal: false,
        gaze: { label: "top left", source: "none" },
      }).map((c) => c.key),
    ).toEqual(ORDER);
  });

  test("every chip has a state from the three the CSS knows", () => {
    for (const c of chips({})) {
      expect(["ok", "warn", "off"]).toContain(c.state);
    }
  });

  test("every chip's tooltip is non-empty — it is where the source or the fix lives", () => {
    const states: Partial<StatusSnapshot>[] = [
      {},
      { tracking: true, mic: "waiting", face: { kind: "starting" } },
      { tracking: true, mic: "off", face: { kind: "unknown" }, keysGlobal: false, fps: 0 },
      { gaze: { label: "top left", source: "window" } },
      { gaze: { label: "center", source: "none" } },
      {
        tracking: true,
        face: { kind: "info", width: 640, height: 480, frames: 0, failed: true },
      },
    ];
    for (const patch of states) {
      for (const c of chips(patch)) {
        expect(c.tooltip.length).toBeGreaterThan(0);
      }
    }
  });

  test("no label is longer than a chip should be in a 295 px foot", () => {
    // A label wider than this cannot sit beside another one; wrapping handles
    // the rest, but a 40-character chip is a sentence, not a chip.
    for (const c of chips({
      tracking: true,
      mic: "waiting",
      face: { kind: "info", width: 1024, height: 768, frames: 99999, failed: false },
      gaze: { label: "bottom right", source: "window" },
    })) {
      expect(c.label.length).toBeLessThanOrEqual(32);
    }
  });
});

describe("mode", () => {
  test("manual mode says manual and names the key that leaves it", () => {
    expect(chip({}, "mode")).toMatchObject({ label: "manual", state: "ok" });
    expect(tooltip({}, "mode")).toContain("press M");
  });

  test("tracking mode says track", () => {
    expect(chip({ tracking: true }, "mode")).toMatchObject({ label: "track", state: "ok" });
  });
});

describe("device", () => {
  test("names the camera, the size and the pixel format", () => {
    expect(label({}, "device")).toBe("Upright Camera 1280×720 YUYV");
  });

  test("the tooltip carries the device path, which the label has no room for", () => {
    expect(tooltip({}, "device")).toContain("/dev/video10");
  });
});

describe("measured rate", () => {
  test("is rounded, and the format is not", () => {
    expect(label({ fps: 24.5 }, "fps")).toBe("25 fps");
    expect(label({ fps: 59.94 }, "fps")).toBe("60 fps");
  });

  test("is ok at the target, a warning below 20, and off at zero", () => {
    expect(chip({ fps: 30 }, "fps").state).toBe("ok");
    expect(chip({ fps: FPS_WARN_BELOW }, "fps").state).toBe("ok");
    expect(chip({ fps: FPS_WARN_BELOW - 1 }, "fps")).toMatchObject({
      label: "19 fps",
      state: "warn",
    });
    expect(chip({ fps: 0 }, "fps")).toMatchObject({ label: "0 fps", state: "off" });
  });

  test("a slow rate's tooltip says what to do about it", () => {
    expect(tooltip({ fps: 8 }, "fps")).toContain("settings.json");
  });
});

describe("dropped frames", () => {
  test("zero is fine and says so", () => {
    expect(chip({ framesDropped: 0 }, "dropped")).toMatchObject({
      label: "0 dropped",
      state: "ok",
    });
    expect(tooltip({ framesDropped: 0 }, "dropped")).toContain("1234 frames in");
  });

  test("any drop is a warning that gives both numbers", () => {
    expect(chip({}, "dropped")).toMatchObject({ label: "3 dropped", state: "warn" });
    expect(tooltip({}, "dropped")).toContain("3 of 1234");
  });
});

describe("microphone", () => {
  test("live says live, and is the only ok state", () => {
    expect(chip({ mic: null }, "mic")).toMatchObject({ label: "mic live", state: "ok" });
  });

  test("waiting is a warning, off is off, and both say what is happening", () => {
    expect(chip({ mic: "waiting" }, "mic")).toMatchObject({
      label: "mic waiting",
      state: "warn",
    });
    expect(chip({ mic: "off" }, "mic")).toMatchObject({ label: "mic off", state: "off" });
    expect(tooltip({ mic: "off" }, "mic")).toContain("wireplumber");
  });
});

describe("face camera", () => {
  test("manual mode says there is nothing to track, not that it failed", () => {
    expect(chip({}, "face")).toMatchObject({ label: "face —", state: "off" });
  });

  test("tracking mode reports the size and the frames read", () => {
    expect(
      chip(
        {
          tracking: true,
          face: { kind: "info", width: 640, height: 480, frames: 700, failed: false },
        },
        "face",
      ),
    ).toMatchObject({ label: "face 640×480 700 fr", state: "ok" });
  });

  test("a failed camera says off instead of a frame count", () => {
    const failed = chip(
      {
        tracking: true,
        face: { kind: "info", width: 640, height: 480, frames: 0, failed: true },
      },
      "face",
    );
    expect(failed).toMatchObject({ label: "face 640×480 off", state: "off" });
    expect(failed.label).not.toContain("fr");
  });

  test("a camera that has not opened yet says starting", () => {
    expect(chip({ tracking: true, face: { kind: "starting" } }, "face")).toMatchObject({
      label: "face starting",
      state: "warn",
    });
  });

  test("a failed status poll says `?`, and does not claim a lift", () => {
    const text = tooltip({ tracking: true, face: { kind: "unknown" }, lowLightGain: 1.8 }, "face");
    expect(label({ tracking: true, face: { kind: "unknown" } }, "face")).toBe("face ?");
    expect(text).not.toContain("lift");
  });

  test("the low-light lift appears in the tooltip only when it did something", () => {
    const info: StatusSnapshot["face"] = {
      kind: "info",
      width: 640,
      height: 480,
      frames: 12,
      failed: false,
    };
    expect(tooltip({ tracking: true, face: info, lowLightGain: 1.05 }, "face")).not.toContain(
      "lift",
    );
    expect(tooltip({ tracking: true, face: info, lowLightGain: 1.66 }, "face")).toContain(
      "lift ×1.7",
    );
    // Outside tracking mode the stage never ran, so there is nothing to report.
    expect(tooltip({ face: info, lowLightGain: 1.66 }, "face")).not.toContain("lift");
  });
});

describe("keys", () => {
  test("global is fine; window is a warning with the udev command", () => {
    expect(chip({}, "keys")).toMatchObject({ label: "keys global", state: "ok" });
    expect(chip({ keysGlobal: false }, "keys")).toMatchObject({
      label: "keys window",
      state: "warn",
    });
    expect(tooltip({ keysGlobal: false }, "keys")).toContain(inputDenied().fix ?? "unreachable");
  });
});

describe("origin", () => {
  test("a monitor cursor is fine and names the anchor", () => {
    expect(chip({}, "origin")).toMatchObject({ label: "origin center", state: "ok" });
    expect(tooltip({}, "origin")).toContain("whole monitor");
  });

  test("the window fallback and no source at all are visible without hovering", () => {
    expect(chip({ gaze: { label: "top left", source: "window" } }, "origin")).toMatchObject({
      label: "origin top left",
      state: "warn",
    });
    expect(chip({ gaze: { label: "top left", source: "none" } }, "origin")).toMatchObject({
      label: "origin top left",
      state: "off",
    });
  });

  test("tracking mode still names the origin, since the gaze uses it too", () => {
    expect(chip({ tracking: true, gaze: { label: "bottom right", source: "monitor" } }, "origin"))
      .toMatchObject({ label: "origin bottom right", state: "ok" });
  });
});
