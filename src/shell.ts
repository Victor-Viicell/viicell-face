import { classify, inputDenied, type AppError, type ErrorCode, type ErrorSource } from "./errors";
import type { CalibrationKind } from "./face/calibration";
import { layoutFor, type Layout, type LayoutState } from "./layout";
import { LookOverlay } from "./look_overlay";
import type { FaceMode } from "./mode";

/**
 * Everything that reads or writes a DOM node.
 *
 * This module is the only place that knows the element ids: the rest of the app
 * asks for a state ("the stream is live", "this device failed") and this file
 * decides what that looks like. It holds no timer and no camera state, so a
 * repaint here can never start work.
 */

/** What the HUD line is saying; sets its colour. */
export type HudState = "starting" | "live" | "idle" | "error" | "preview";

/** What the preview says while the camera is not running. */
export const CAMERA_OFF_MESSAGE = "camera off · manual mode";

/** Waiting for the webcam to open, in either the preview or the calibration. */
export const CAMERA_WAITING_MESSAGE = "waiting for the camera…";

const q = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!;

export const canvas = q<HTMLCanvasElement>("#output");
export const retryButton = q<HTMLButtonElement>("#retry");
export const errorCopy = q<HTMLButtonElement>("#error-copy");
export const errorDismiss = q<HTMLButtonElement>("#error-dismiss");
export const inputHintCopy = q<HTMLButtonElement>("#input-hint-copy");
export const calibrationNext = q<HTMLButtonElement>("#calibration-next");
export const calibrationCancel = q<HTMLButtonElement>("#calibration-cancel");
export const calibrateButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-calibration]")];
/** The fold toggle of the docked column; `main.ts` wires its click. */
export const panelToggle = q<HTMLButtonElement>("#panel-toggle");
/** The scrolling half of the dock; the camera preview docks here between runs. */
const panelBody = q<HTMLElement>("#panel-body");
/** The camera preview canvas; it moves into the calibration panel and back. */
export const debugCanvas = document.querySelector<HTMLCanvasElement>("#debug-camera");

const hud = q<HTMLElement>("#hud");
const hudText = q<HTMLElement>("#hud-text");
const errorPanel = q<HTMLElement>("#error-panel");
const errorTitle = q<HTMLElement>("#error-title");
const errorText = q<HTMLElement>("#error-text");
const errorFix = q<HTMLElement>("#error-fix");
const errorFixText = q<HTMLElement>("#error-fix-text");
const inputHint = q<HTMLElement>("#input-hint");
const inputHintText = q<HTMLElement>("#input-hint-text");
const inputHintFix = q<HTMLElement>("#input-hint-fix");
const trackHint = q<HTMLElement>("#track-hint");
const calibrationPanel = q<HTMLElement>("#calibration");
const calibrationCount = q<HTMLElement>("#calibration-count");
const calibrationText = q<HTMLElement>("#calibration-text");
const calibrationNote = q<HTMLElement>("#calibration-note");
const calibrationFill = q<HTMLElement>("#calibration-fill");
const calibrationCamera = q<HTMLElement>("#calibration-camera");
const calibrationKindLabel = q<HTMLElement>("#calibration-kind");
const calibrateGroup = q<HTMLElement>("#calibrate");
const modeName = q<HTMLElement>("#mode-name");
const modeRow = document.querySelector<HTMLElement>("#mode-row");
const leanRow = document.querySelector<HTMLElement>("#lean-row");
const debugRow = document.querySelector<HTMLElement>("#debug-row");
const lookRow = document.querySelector<HTMLElement>("#look-row");

/** The tracked-gaze crosshair and its calibration marks. */
export const lookOverlay = new LookOverlay(
  q<HTMLElement>("#look-overlay"),
  q<HTMLElement>("#look-crosshair"),
  q<HTMLElement>("#look-target"),
);

const rows = { lean: leanRow, debug: debugRow, look: lookRow } as const;

/**
 * The docked layout, painted from the maths.
 *
 * `layout.ts` decides where the canvas and the column are; this writes the
 * result into the custom properties `styles.css` reads, and repaints on every
 * resize. The state is read through a callback so the remembered width and the
 * folded flag stay in the settings store — there is no second copy here.
 */
let paintLayout: () => void = () => {};

export function installLayout(state: () => LayoutState): void {
  const root = document.documentElement;
  paintLayout = (): void => {
    const current = state();
    const layout: Layout = layoutFor(
      { width: window.innerWidth, height: window.innerHeight },
      current,
    );
    root.style.setProperty("--panel-width", `${layout.panel.width}px`);
    root.style.setProperty("--view-x", `${layout.view.x}px`);
    root.style.setProperty("--view-y", `${layout.view.y}px`);
    root.style.setProperty("--view-w", `${layout.view.width}px`);
    root.style.setProperty("--view-h", `${layout.view.height}px`);
    document.body.classList.toggle("folded", current.collapsed);
    panelToggle.setAttribute("aria-expanded", current.collapsed ? "false" : "true");
  };
  window.addEventListener("resize", () => paintLayout());
  paintLayout();
}

/** Repaints the layout after the store changed under it (fold, width). */
export function relayout(): void {
  paintLayout();
}

/** The status line under the canvas. */
export function setHud(state: HudState, text: string): void {
  hud.dataset.state = state;
  hudText.textContent = text;
}

/** Which input drives the face: the mode name and the highlighted rows. */
export function applyModeUi(mode: FaceMode): void {
  document.body.dataset.mode = mode;
  // A failure dismissed in one mode should be allowed to speak in the other.
  clearDismissed();
  modeName.textContent = mode === "track" ? "facial track" : "manual";
  modeRow?.classList.toggle("active", mode === "track");
  leanRow?.classList.remove("active");
}

/** Highlights a row of keys that is currently doing something. */
export function setRowActive(row: keyof typeof rows, active: boolean): void {
  rows[row]?.classList.toggle("active", active);
}

/** The crosshair is up: the window is the whole monitor and nothing else shows. */
export function setLooking(looking: boolean): void {
  document.body.classList.toggle("looking", looking);
}

/**
 * What the calibration panel says, already resolved.
 *
 * The panel does not read the tracker: the flow decides which instruction and
 * which button label are honest right now, and hands the strings over.
 */
export interface CalibrationView {
  /** The part of the face being measured ("Mouth", "Eyes", …). */
  kindLabel: string;
  /** Step counter, e.g. `2/3`. */
  count: string;
  /** The instruction for this step. */
  text: string;
  /** 0–100, for the progress bar. */
  fillPercent: number;
  /** The line under the instruction: what the tracker is waiting for. */
  note: string;
  /** `Start`, `Next` or `Finish`. */
  nextLabel: string;
}

export function paintCalibration(view: CalibrationView): void {
  calibrationKindLabel.textContent = view.kindLabel;
  calibrationCount.textContent = view.count;
  calibrationText.textContent = view.text;
  calibrationFill.style.width = `${view.fillPercent}%`;
  calibrationNote.textContent = view.note;
  calibrationNext.textContent = view.nextLabel;
}

/** Swaps the preset buttons for the step-by-step panel and lends it the preview. */
export function openCalibrationPanel(): void {
  calibrateGroup.hidden = true;
  calibrationPanel.hidden = false;
  if (debugCanvas) {
    calibrationCamera.append(debugCanvas);
  }
}

/** Puts the preset buttons back and returns the preview to the dock. */
export function closeCalibrationPanel(): void {
  calibrationPanel.hidden = true;
  calibrateGroup.hidden = false;
  if (debugCanvas) {
    panelBody.prepend(debugCanvas);
  }
}

/** In the browser preview there is nothing to calibrate against. */
export function setCalibrateAvailable(available: boolean): void {
  calibrateGroup.hidden = !available;
}

/** Marks the parts that have never been measured, so the button says so. */
export function paintCalibrationAttention(
  tracking: boolean,
  calibrating: boolean,
  measured: (kind: CalibrationKind) => boolean,
): void {
  for (const button of calibrateButtons) {
    const kind = button.dataset.calibration as CalibrationKind;
    button.classList.toggle("attention", tracking && !calibrating && !measured(kind));
  }
}

/** The hint under the HUD for window-only keys; the whole strip shows or hides. */
export function setInputHint(hidden: boolean): void {
  inputHint.hidden = hidden;
}

/** Why the tracking camera is not running, if it is not. */
export function setTrackHint(message: string | null): void {
  trackHint.hidden = message === null;
  trackHint.textContent = message === null ? "" : `facial track: ${message}`;
  if (message !== null) {
    console.warn(`viicell-face: ${message}`);
  }
}

/**
 * The failure the panel is showing, and the codes this person has waved away.
 *
 * One slot: the panel never stacks, and a problem that persists does not repaint
 * every poll (`setPanelProblem` returns early on an unchanged error). Dismissing
 * is per code and only until the device recovers — a fixed mic that breaks again
 * gets to say so once more.
 */
let panelProblem: AppError | null = null;
const dismissed = new Set<ErrorCode>();

/** A device recovered: the next failure of this kind may speak again. */
export function clearDismissed(): void {
  dismissed.clear();
}

/** Forgets specific dismissals, e.g. the mic's once it goes live. */
export function forgetDismissed(...codes: ErrorCode[]): void {
  for (const code of codes) {
    dismissed.delete(code);
  }
}

export function setPanelProblem(next: AppError | null): void {
  if (next !== null && dismissed.has(next.code)) {
    if (panelProblem !== null) {
      panelProblem = null;
      errorPanel.hidden = true;
    }
    return;
  }
  if (
    panelProblem !== null &&
    next !== null &&
    panelProblem.code === next.code &&
    panelProblem.detail === next.detail
  ) {
    return;
  }
  panelProblem = next;
  if (next === null) {
    errorPanel.hidden = true;
    errorPanel.removeAttribute("data-code");
    return;
  }

  errorTitle.textContent = next.message;
  errorText.textContent = next.detail;
  errorPanel.dataset.code = next.code;
  // The one action the ticket promises: the command, ready to copy. Failures
  // whose fix is "plug a device in" have none, and then there is no row.
  const fix = next.fix ?? "";
  errorFix.hidden = fix.length === 0;
  errorFixText.textContent = fix;
  errorCopy.textContent = "Copy";
  errorPanel.hidden = false;
  setHud("error", next.message);
}

/** Classifies whatever a `catch` caught and shows it. Never a raw string. */
export function showError(error: unknown, source: ErrorSource = "camera"): void {
  setPanelProblem(classify(error, source));
}

export function hideError(): void {
  if (panelProblem !== null) dismissed.delete(panelProblem.code);
  setPanelProblem(null);
}

/**
 * Hides the panel until that failure changes.
 *
 * The status poll runs every second, so an un-suppressed panel would be pushed
 * straight back up; dismissal is per code and a device that recovers clears the
 * mark (see the microphone's live state), so a later failure is never swallowed.
 */
export function dismissProblem(): void {
  if (panelProblem !== null) dismissed.add(panelProblem.code);
  panelProblem = null;
  errorPanel.hidden = true;
}

/**
 * Fills the window-only-keys hint from the same taxonomy the panel uses.
 *
 * It stays a hint rather than an error: posing the face still works here, only
 * the global part does not, so this must never cover the canvas.
 */
export function fillInputHint(): void {
  const problem = inputDenied();
  inputHintText.textContent = problem.message;
  inputHintFix.textContent = problem.fix ?? "";
  inputHintFix.hidden = problem.fix === undefined;
  inputHintCopy.hidden = problem.fix === undefined;
}

/** Copies the panel's fix command. */
export function copyErrorFix(): Promise<void> {
  return copyCommand(errorFixText.textContent ?? "", errorCopy);
}

/** Copies the input hint's fix command. */
export function copyInputFix(): Promise<void> {
  return copyCommand(inputHintFix.textContent ?? "", inputHintCopy);
}

/** Copies a fix command, then says so on the button for a moment. */
async function copyCommand(text: string, button: HTMLButtonElement): Promise<void> {
  if (text.length === 0) return;
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    // A webview can refuse the async clipboard; the selection path still copies.
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    area.remove();
  }
  button.textContent = copied ? "Copied" : "Copy failed";
  window.setTimeout(() => {
    button.textContent = "Copy";
  }, 1200);
}
