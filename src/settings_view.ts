/**
 * What the settings panel shows, decided without a DOM.
 *
 * The panel itself (`./settings_panel`) is a handful of listeners and two
 * paints; everything with a rule — which sizes a person may pick, how a typed
 * size is read, what a stored setting looks like on the controls — is here so
 * `bun test` can pin it without a window (there is no DOM in this test rig).
 *
 * Nothing here writes: the panel always goes through `SettingsStore.set()`, so
 * the store's merge/clamp is the only gate before a value reaches Rust.
 */

import { ANCHOR_LABELS, GAZE_ANCHORS, type GazeAnchor } from "./anchor";
import { LIMITS, type Settings } from "./settings";

/** One entry of the size picker. */
export interface OutputChoice {
  width: number;
  height: number;
  /** What the `<option>` reads, and what `parseSize` accepts back. */
  label: string;
}

/**
 * The sizes worth offering, largest first.
 *
 * All sixteen-by-nine: the face is drawn on a 1920×1080 artboard and scaled by
 * width, so a size of another shape would letterbox the face in the frames
 * other apps capture. The saved size may be anything the store clamps; it gets
 * its own entry rather than being hidden by this list.
 */
export const OUTPUT_PRESETS: readonly { width: number; height: number }[] = [
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
  { width: 960, height: 540 },
  { width: 640, height: 360 },
];

/** The rates worth offering, fastest first. Anything else saved is kept. */
export const FPS_PRESETS: readonly number[] = [60, 30, 24, 15];

/** `1280×720` — one character for both the picker and the size chip. */
export function sizeLabel(width: number, height: number): string {
  return `${width}×${height}`;
}

/**
 * The size picker's entries: the presets, with the saved size first when it is
 * not one of them, so the control never shows a size the store does not hold.
 */
export function outputChoices(width: number, height: number): OutputChoice[] {
  const choices: OutputChoice[] = OUTPUT_PRESETS.map((preset) => ({
    width: preset.width,
    height: preset.height,
    label: sizeLabel(preset.width, preset.height),
  }));
  if (!choices.some((choice) => choice.width === width && choice.height === height)) {
    choices.unshift({ width, height, label: sizeLabel(width, height) });
  }
  return choices;
}

/** The rate picker's entries: the presets, fastest first, plus an odd saved one. */
export function fpsChoices(fps: number): number[] {
  const choices = [...FPS_PRESETS];
  if (!choices.includes(fps)) {
    choices.push(fps);
  }
  return choices.sort((a, b) => b - a);
}

/** A stored size clamped into what YUYV on a loopback device can carry. */
function clampEven(value: number, min: number, max: number): number {
  const clamped = Math.min(max, Math.max(min, Math.round(value)));
  return clamped - (clamped % 2);
}

/**
 * Reads a size back off the picker, or `null` when it is not a size.
 *
 * Even and in range before it is stored: `start_camera` refuses an odd width, so
 * a value that came from anywhere but the presets is made legal here rather than
 * failing as a device error two steps later. The store clamps again — this is
 * the same rule applied early, not a second one.
 */
export function parseSize(text: string): { width: number; height: number } | null {
  const match = /^\s*(\d{2,5})\s*[x×*]\s*(\d{2,5})\s*$/i.exec(text);
  if (match === null) {
    return null;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return {
    width: clampEven(width, LIMITS.output.minWidth, LIMITS.output.maxWidth),
    height: clampEven(height, LIMITS.output.minHeight, LIMITS.output.maxHeight),
  };
}

/** The origin buttons, in the reading order the two-column grid paints them. */
export const ORIGIN_ORDER: readonly GazeAnchor[] = [
  "topLeft",
  "topRight",
  "center",
  "bottomLeft",
  "bottomRight",
];

/** A button's text: the shared label, and the anchor it picks. */
export function originLabel(anchor: GazeAnchor): string {
  return ANCHOR_LABELS[anchor];
}

/** Every anchor the store accepts has a button, and the keys pick the same five. */
export function originChoices(): { anchor: GazeAnchor; label: string }[] {
  return ORIGIN_ORDER.filter((anchor) => (GAZE_ANCHORS as readonly string[]).includes(anchor)).map(
    (anchor) => ({ anchor, label: originLabel(anchor) }),
  );
}

/** What each control should read, from the store alone. */
export interface PanelView {
  /** The selected `<option>` value of the size picker. */
  size: string;
  /** The selected `<option>` value of the rate picker. */
  fps: string;
  origin: GazeAnchor;
  startTrack: boolean;
}

/**
 * One paint's worth of truth.
 *
 * The origin comes from here rather than from the `Gaze` object, so the grid and
 * the status row's `origin` chip cannot disagree: both are read from the store,
 * and the keys and the grid write it the same way.
 */
export function panelView(settings: Settings): PanelView {
  const { width, height, fps } = settings.output;
  return {
    size: sizeLabel(width, height),
    fps: String(fps),
    origin: settings.gazeOrigin,
    startTrack: settings.startMode === "track",
  };
}
