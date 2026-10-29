import type { Application } from "pixi.js";
import { MOUTH } from "./face/art";
import type { FaceRig } from "./face/rig";
import { GAZE_ANCHORS, type Gaze, type GazeAnchor } from "./gaze";
import { subscribeInput } from "./input";
import { MODE_KEY, RECENTRE_KEY, faceMode, toggleFaceMode } from "./mode";
import type { SettingsStore } from "./settings";
import { setRowActive } from "./shell";

/**
 * The keys and the wheel: posing the face by hand.
 *
 * One control stream feeds this (`./input`), whether it comes from the input
 * devices while the app runs or from the focused window. Nothing here touches
 * the DOM except through `./shell`, so the pose logic stays readable.
 */

type EyePart = "brows" | "cheeks" | "eyes";
type SizePart = "iris" | "pupils";
type MouthPart = "width" | "open" | "bottom" | "corner";

interface EyeControl {
  part: EyePart;
  key: string;
  /** Manual closure, 0 = open, 1 = closed. Never touched by a blink. */
  closure: number;
  /** Closure a blink returns to when it finishes. */
  base: number;
  /** Last value sent to the rig; a blink may be mid-flight. */
  applied: number;
  /** Closure the lid was drawn at when a blink started. */
  blinkFrom: number;
  /** `performance.now()` when the blink started; 0 when idle. */
  blinkStart: number;
  held: boolean;
  scrolled: boolean;
  pressedAt: number;
}

interface SizeControl {
  part: SizePart;
  key: string;
  /** Multiplier on the artwork, 1 = as drawn. */
  value: number;
  /** Value a tap animates back from, and when it started; 0 when idle. */
  from: number;
  resetStart: number;
  held: boolean;
  scrolled: boolean;
  pressedAt: number;
}

interface MouthControl {
  part: MouthPart;
  key: string;
  /** Pose amount; corners run from -1 sad through 0 flat to 1 happy. */
  value: number;
  /** Pose a tap returns to. */
  rest: number;
  /** Value a tap animates back from, and when it started; 0 when idle. */
  from: number;
  resetStart: number;
  held: boolean;
  scrolled: boolean;
  pressedAt: number;
}

/** Hold a key and scroll to open/close; tap it to blink. One-hand row. */
const EYE_KEYS: Record<EyePart, string> = { brows: "z", cheeks: "x", eyes: "c" };
/** The next two keys sit beside them: iris and pupil sizing. */
const SIZE_KEYS: Record<SizePart, string> = { iris: "v", pupils: "b" };
/**
 * The mouth row, manual mode only: `N` width, `J` open, `L` lower lip, `H`
 * corners (scroll up happy, down sad). In camera mode the tracker owns these
 * channels like it owns the lids, so the keys are ignored there.
 */
const MOUTH_KEYS: Record<MouthPart, string> = { width: "n", open: "j", bottom: "l", corner: "h" };
/** Toggles the tracking camera preview (see `face/debug_view.ts`). */
const DEBUG_KEY = "t";
/** Toggles the full-monitor gaze crosshair, in tracking mode. */
const LOOK_KEY = "g";
/** Multiplier limits, matching what the rig accepts. */
const SIZE_RANGE: Record<SizePart, readonly [number, number]> = {
  iris: [0.4, 1.6],
  pupils: [0.2, 2.6],
};
const WHEEL_STEP = 0.2;
const SIZE_STEP = 0.08;
const MOUTH_STEP = 0.08;
const TAP_MS = 350;
const RESET_MS = 160;
const BLINK_CLOSE_MS = 110;
const BLINK_OPEN_MS = 190;
/**
 * Time constant of the lid easing, in seconds. Scrolling only moves the target,
 * so the lid glides on at the same rate however large the step was: one notch
 * and five land as one motion instead of a jump on the frame the wheel turned.
 */
const CLOSE_TAU = 0.12;
/** Closer than this and the lid is on target; snap the remainder so it settles. */
const CLOSE_EPSILON = 0.0015;

/** What the manual controls need from the rest of the app. */
export interface FaceControlHooks {
  /** `R`: open the mouth calibration (also retries a camera that failed). */
  calibrate: () => void;
  /** `G`: show or hide the tracked-gaze crosshair. */
  toggleLookOverlay: () => void;
  /** `T`: flip the camera preview, and say whether it is now up. */
  togglePreview: () => boolean;
  /** The calibration panel owns the preview while it is open. */
  calibrating: () => boolean;
}

/**
 * Eye controls.
 *
 * `Z` + wheel drives the brows, `X` + wheel the cheeks, `C` + wheel the eyes:
 * scroll up opens and scroll down closes. Keys combine, so `Z` + `X` + wheel
 * moves both lids. Tapping a key blinks that part: it closes fully and reopens
 * to wherever the manual controls left it.
 *
 * `V` + wheel grows or shrinks the iris, `B` + wheel blooms or thins the pupil;
 * tapping either eases it back to the drawn size.
 */
export function setupFaceControls(
  app: Application,
  rig: FaceRig,
  hooks: FaceControlHooks,
): { reapply: () => void } {
  const controls: EyeControl[] = (Object.keys(EYE_KEYS) as EyePart[]).map((part) => ({
    part,
    key: EYE_KEYS[part],
    closure: 0,
    base: 0,
    applied: 0,
    blinkFrom: 0,
    blinkStart: 0,
    held: false,
    scrolled: false,
    pressedAt: 0,
  }));

  const sizes: SizeControl[] = (Object.keys(SIZE_KEYS) as SizePart[]).map((part) => ({
    part,
    key: SIZE_KEYS[part],
    value: 1,
    from: 1,
    resetStart: 0,
    held: false,
    scrolled: false,
    pressedAt: 0,
  }));

  const restOf = (part: MouthPart): number => {
    switch (part) {
      case "width":
        return MOUTH.rest.width;
      case "open":
        return MOUTH.rest.open;
      case "bottom":
        return MOUTH.rest.bottomWidth;
      case "corner":
        return MOUTH.rest.corner;
    }
  };

  const mouths: MouthControl[] = (Object.keys(MOUTH_KEYS) as MouthPart[]).map((part) => ({
    part,
    key: MOUTH_KEYS[part],
    value: restOf(part),
    rest: restOf(part),
    from: restOf(part),
    resetStart: 0,
    held: false,
    scrolled: false,
    pressedAt: 0,
  }));

  const applyMouth = (control: MouthControl, amount: number) => {
    if (control.part === "corner") {
      control.value = Math.min(1, Math.max(-1, amount));
      rig.setMouthCorner("left", control.value);
      rig.setMouthCorner("right", control.value);
      return;
    }

    control.value = Math.min(1, Math.max(0, amount));
    if (control.part === "width") {
      rig.setMouthWidth(control.value);
    } else if (control.part === "open") {
      rig.setMouthOpen(control.value);
    } else {
      rig.setMouthBottomWidth(control.value);
    }
  };

  const applyClosure = (control: EyeControl, closure: number) => {
    const value = Math.min(1, Math.max(0, closure));
    control.applied = value;
    if (control.part === "brows") {
      rig.setBrowClose(value);
    } else if (control.part === "cheeks") {
      rig.setCheekClose(value);
    } else {
      rig.setEyeClose(value);
    }
  };

  /** Moves the target; the ticker eases the lid onto it. */
  const setClosure = (control: EyeControl, closure: number) => {
    control.closure = Math.min(1, Math.max(0, closure));
  };

  const applySize = (control: SizeControl, size: number) => {
    const [min, max] = SIZE_RANGE[control.part];
    control.value = Math.min(max, Math.max(min, size));
    if (control.part === "iris") {
      rig.setIrisScale(control.value);
    } else {
      rig.setPupilWidth(control.value);
    }
  };

  // One stream for both input sources: the devices themselves while the app
  // runs, the focused window's events otherwise.
  subscribeInput((input) => {
    if (input.type === "wheel") {
      // Scroll up opens, grows and blooms; scroll down does the opposite.
      const notches = input.notches;

      // Every held key moves, so `Z` + `X` closes the brow and cheek lids
      // together. In camera mode the tracker owns those lids, so the keys are
      // ignored; the iris and pupil keys keep working in both modes.
      if (faceMode() === "manual") {
        for (const control of controls.filter((candidate) => candidate.held)) {
          control.scrolled = true;

          if (control.blinkStart !== 0) {
            // Take over from wherever the lid is, instead of snapping back to the
            // manual pose before applying the scroll step.
            control.closure = control.applied;
            control.blinkStart = 0;
          }

          // Closure counts up as the lid shuts, and `notches` is positive for a
          // scroll up, so the step is subtracted: up opens, down closes.
          setClosure(control, control.closure - notches * WHEEL_STEP);
        }

        // Mouth channels move the same way as the lids: up widens, opens,
        // widens the lower lip or lifts the corners; down does the opposite.
        for (const control of mouths.filter((candidate) => candidate.held)) {
          control.scrolled = true;
          control.resetStart = 0;
          applyMouth(control, control.value + notches * MOUTH_STEP);
        }
      }

      for (const control of sizes.filter((candidate) => candidate.held)) {
        control.scrolled = true;
        control.resetStart = 0;
        applySize(control, control.value + notches * SIZE_STEP);
      }
      return;
    }

    if (input.name === MODE_KEY) {
      if (input.type === "keydown") {
        toggleFaceMode();
      }
      return;
    }

    if (input.name === RECENTRE_KEY) {
      if (input.type === "keydown" && faceMode() === "track") {
        // Also retries the camera when it never opened.
        hooks.calibrate();
      }
      return;
    }

    if (input.type === "keydown" && input.name === "d") {
      // Joints, pivots and bone names, for rigging work.
      rig.skeleton.visible = !rig.skeleton.visible;
      return;
    }

    if (input.type === "keydown" && input.name === DEBUG_KEY) {
      if (hooks.calibrating()) {
        // The calibration panel owns the preview while it is open.
        return;
      }
      // The camera the landmarker reads, with its landmarks over it.
      setRowActive("debug", hooks.togglePreview());
      return;
    }

    if (input.type === "keydown" && input.name === LOOK_KEY) {
      // Where the tracker thinks the eyes look, over the whole monitor.
      hooks.toggleLookOverlay();
      return;
    }

    if (input.name === "space") {
      if (faceMode() === "track") {
        return;
      }
      // Held down, the gaze holds where it is while the lean keeps following the
      // cursor; releasing lets the gaze glide back onto the live look.
      const frozen = input.type === "keydown";
      rig.setEyesFrozen(frozen);
      setRowActive("lean", frozen);
      return;
    }

    const size = sizes.find((candidate) => candidate.key === input.name);
    if (size) {
      if (input.type === "keydown") {
        size.held = true;
        size.scrolled = false;
        size.pressedAt = performance.now();
        size.resetStart = 0;
        return;
      }

      if (!size.held) {
        return;
      }

      size.held = false;
      // A tap eases the part back to the size it is drawn at.
      if (!size.scrolled && performance.now() - size.pressedAt <= TAP_MS) {
        size.from = size.value;
        size.resetStart = performance.now();
      }
      return;
    }

    // What follows only exists in manual mode: the camera poses these lids
    // itself, and a key press must not fight it.
    if (faceMode() === "track") {
      return;
    }

    const mouthControl = mouths.find((candidate) => candidate.key === input.name);
    if (mouthControl) {
      if (input.type === "keydown") {
        mouthControl.held = true;
        mouthControl.scrolled = false;
        mouthControl.pressedAt = performance.now();
        mouthControl.resetStart = 0;
        return;
      }

      if (!mouthControl.held) {
        return;
      }

      mouthControl.held = false;
      // A tap eases the channel back to the artwork's rest pose.
      if (
        !mouthControl.scrolled &&
        performance.now() - mouthControl.pressedAt <= TAP_MS
      ) {
        mouthControl.from = mouthControl.value;
        mouthControl.resetStart = performance.now();
      }
      return;
    }

    const control = controls.find((candidate) => candidate.key === input.name);
    if (!control) {
      return;
    }

    if (input.type === "keydown") {
      control.held = true;
      control.scrolled = false;
      control.pressedAt = performance.now();
      // Do not cancel a running blink here: a rapid re-tap restarts it from the
      // manual pose on keyup, so mashing the key can never leave it shut.
      return;
    }

    if (!control.held) {
      return;
    }

    control.held = false;
    // Ignore taps while a blink is still running: mashing the key just lets
    // the current blink finish instead of restarting (and popping open) it.
    if (
      control.blinkStart === 0 &&
      !control.scrolled &&
      performance.now() - control.pressedAt <= TAP_MS
    ) {
      // Start from where the lid is drawn, which may still be gliding towards a
      // scroll target, and return to that target when the blink is over.
      control.blinkFrom = control.applied;
      control.base = control.closure;
      control.blinkStart = performance.now();
    }
  });

  // A missed keyup (window switched away) must not leave a control held.
  window.addEventListener("blur", () => {
    for (const control of controls) {
      control.held = false;
    }
    for (const control of sizes) {
      control.held = false;
    }
    for (const control of mouths) {
      control.held = false;
    }
    rig.setEyesFrozen(false);
    setRowActive("lean", false);
  });

  /**
   * Pushes the manual pose back onto the rig, e.g. after the camera mode has
   * been posing the same bones.
   */
  const reapply = () => {
    rig.setEyesFrozen(false);
    for (const control of controls) {
      control.blinkStart = 0;
      control.held = false;
      applyClosure(control, control.closure);
    }
    for (const control of sizes) {
      control.resetStart = 0;
      control.held = false;
      applySize(control, control.value);
    }
    for (const control of mouths) {
      control.resetStart = 0;
      control.held = false;
      applyMouth(control, control.value);
    }
  };

  app.ticker.add(() => {
    const now = performance.now();
    // Frame-rate independent easing for the scroll-driven lids.
    const alpha = 1 - Math.exp(-Math.max(app.ticker.deltaMS, 0) / 1000 / CLOSE_TAU);

    // In camera mode the tracker writes these bones every frame; easing the
    // manual targets on top would fight it.
    if (faceMode() === "manual") {
      for (const control of controls) {
        if (control.blinkStart === 0) {
          // Chase the target left behind by the wheel. A blink owns `applied`
          // while it runs, so this is skipped then.
          const remaining = control.closure - control.applied;
          if (Math.abs(remaining) <= CLOSE_EPSILON) {
            if (remaining !== 0) {
              applyClosure(control, control.closure);
            }
          } else {
            applyClosure(control, control.applied + remaining * alpha);
          }
          continue;
        }

        const elapsed = now - control.blinkStart;
        if (elapsed >= BLINK_CLOSE_MS + BLINK_OPEN_MS) {
          control.blinkStart = 0;
          applyClosure(control, control.base);
          continue;
        }

        // 0 → 1 (close) → 0 (open), eased so the lid does not snap. The closing
        // half leaves from wherever the lid was; the opening half lands on the
        // manual pose.
        const closing = elapsed < BLINK_CLOSE_MS;
        const phase = closing
          ? elapsed / BLINK_CLOSE_MS
          : 1 - (elapsed - BLINK_CLOSE_MS) / BLINK_OPEN_MS;
        const eased = phase * phase * (3 - 2 * phase);
        const from = closing ? control.blinkFrom : control.base;

        applyClosure(control, from + (1 - from) * eased);
      }

      // A tapped mouth key glides back to the rest pose.
      for (const control of mouths) {
        if (control.resetStart === 0) {
          continue;
        }

        const progress = (now - control.resetStart) / RESET_MS;
        if (progress >= 1) {
          control.resetStart = 0;
          applyMouth(control, control.rest);
          continue;
        }

        const eased = progress * progress * (3 - 2 * progress);
        applyMouth(control, control.from + (control.rest - control.from) * eased);
      }
    }

    for (const control of sizes) {
      if (control.resetStart === 0) {
        continue;
      }

      const progress = (now - control.resetStart) / RESET_MS;
      if (progress >= 1) {
        control.resetStart = 0;
        applySize(control, 1);
        continue;
      }

      const eased = progress * progress * (3 - 2 * progress);
      applySize(control, control.from + (1 - control.from) * eased);
    }
  });

  return { reapply };
}

/**
 * Gaze controls.
 *
 * Hold `0` and press `1`–`5` to pick the point the eyes look *from*: top left,
 * top right, the middle, bottom left, bottom right. The cursor keeps driving the
 * pupils in manual mode and the tracked gaze drives them in camera mode; either
 * way the origin only changes the angle they see the screen at, not what they
 * are following. Tap `0` on its own to put the origin back in the middle.
 *
 * The origin is saved, because it is picked once for a whole call and having to
 * pick it again after every restart was the thing people forgot.
 */
export function setupGazeControls(gaze: Gaze, settings: SettingsStore): void {
  let held = false;
  let picked = false;

  /** Moves the origin and remembers it; the store writes it a beat later. */
  const pick = (origin: GazeAnchor) => {
    gaze.setOrigin(origin);
    settings.set({ gazeOrigin: origin });
  };

  subscribeInput((input) => {
    // The origin applies to both modes: the cursor mode re-centres the pointer,
    // the camera mode re-centres the tracked gaze.
    if (input.type === "wheel") {
      return;
    }

    if (input.name === "0") {
      if (input.type === "keydown") {
        held = true;
        picked = false;
      } else {
        held = false;
        if (!picked) {
          pick("center");
        }
      }
      return;
    }

    if (input.type !== "keydown" || !held) {
      return;
    }

    const index = ["1", "2", "3", "4", "5"].indexOf(input.name);
    if (index === -1) {
      return;
    }

    picked = true;
    pick(GAZE_ANCHORS[index]);
  });

  window.addEventListener("blur", () => {
    held = false;
  });
}
