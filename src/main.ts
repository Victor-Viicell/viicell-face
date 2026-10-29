import { invoke } from "@tauri-apps/api/core";
import { Application } from "pixi.js";
import { BACKGROUND } from "./config";
import { stopCamera } from "./camera";
import { setupFaceControls, setupGazeControls } from "./controls";
import { ARTBOARD } from "./face/art";
import { CameraDebugView } from "./face/debug_view";
import { LowLight } from "./face/lowlight";
import { SynthMouth } from "./face/mouth";
import { FaceRig } from "./face/rig";
import { FaceTracker } from "./face/tracker";
import { FaceTracking } from "./face/tracking";
import { type CalibrationKind } from "./face/calibration";
import { Gaze } from "./gaze";
import { startInput } from "./input";
import { faceMode, setFaceMode, startupFaceMode, subscribeMode } from "./mode";
import { stopFaceCamera } from "./face_camera";
import { installWizard } from "./onboarding_panel";
import { SettingsStore, type SettingsAdapter } from "./settings";
import { installSettingsPanel } from "./settings_panel";
import * as shell from "./shell";
import { applyOutput, connect, installStream, refreshStatus, startStream } from "./stream";
import { TrackView } from "./track_view";

/**
 * Boot and wiring.
 *
 * Everything with a rule of its own lives next door: `./shell` draws, `./stream`
 * owns the frame path and the health poll, `./controls` owns the keys,
 * `./track_view` owns camera mode. This file only builds the objects, connects
 * them in one place, and gets out of the way.
 */

const isTauri = "__TAURI_INTERNALS__" in window;

/**
 * The persisted settings, read once at boot.
 *
 * Only Tauri has a file to read: the browser preview keeps the defaults in
 * memory, so it can never pass for a saved configuration.
 */
const settings = new SettingsStore(isTauri ? tauriSettingsAdapter() : null);

/** The Rust side stores the text; the shape of it lives in `./settings`. */
function tauriSettingsAdapter(): SettingsAdapter {
  return {
    read: () => invoke<string | null>("read_settings"),
    write: (text) => invoke<void>("write_settings", { text }),
  };
}

/** Owns the microphone and the mouth line; created once the app is up. */
let mouth: SynthMouth | null = null;

/** Where the eyes look, and how they get there. */
const gaze = new Gaze();

/** Reads the face from the tracking camera; only loaded in that mode. */
const tracker = new FaceTracker();
/** Lifts a dim frame before the landmark model reads it. */
const lowLight = new LowLight();
/** Turns tracked readings into eased rig poses. */
const tracking = new FaceTracking();
/** The camera preview; null until the window has booted. */
let cameraDebug: CameraDebugView | null = null;
/** Camera mode's camera, crosshair and calibration; created once the rig exists. */
let trackView: TrackView | null = null;
/** Puts the manual pose back on the rig; filled in once the controls exist. */
let reapplyManual: () => void = () => {};

async function boot(): Promise<void> {
  // The saved settings are read before anything depends on them: the canvas
  // buffer, the rig scale, the ticker rate and the v4l2 format all have to
  // agree, and the device only accepts one size at a time.
  const saved = await settings.load();
  const output = saved.output;
  gaze.setOrigin(saved.gazeOrigin);
  // The docked column and the letterboxed canvas, before anything measures the
  // window. `layout.ts` does the maths; the store remembers the width.
  shell.installLayout(() => settings.value("panel"));

  const app = new Application();
  await app.init({
    canvas: shell.canvas,
    width: output.width,
    height: output.height,
    background: BACKGROUND,
    antialias: true,
    resolution: 1,
    autoDensity: false,
    preference: "webgl",
    powerPreference: "high-performance",
  });

  // The face rig is the canvas the camera broadcasts. Posing a bone
  // (`rig.bones.eyeLeftIris.moveBy(...)`) shows up in the next frame.
  const rig = new FaceRig(output.width / ARTBOARD.width);
  app.stage.addChild(rig.root);

  // A DOM canvas over the face, so the preview can never be read back into the
  // virtual camera's frames.
  cameraDebug = shell.debugCanvas ? new CameraDebugView(shell.debugCanvas) : null;
  cameraDebug?.showMessage(
    faceMode() === "track" ? shell.CAMERA_WAITING_MESSAGE : shell.CAMERA_OFF_MESSAGE,
  );

  // The synth line is a spectrum display: the microphone drives its rods along
  // the bottom edge of the face.
  mouth = new SynthMouth();
  rig.bones.synth.node.addChild(mouth.view);
  void mouth.start();
  app.ticker.add(() => mouth?.update());

  trackView = new TrackView({
    isTauri,
    rig,
    tracker,
    lowLight,
    tracking,
    gaze,
    preview: () => cameraDebug,
    reapplyManual: () => reapplyManual(),
  });

  const controls = setupFaceControls(app, rig, {
    calibrate: () => trackView?.startCalibration(),
    toggleLookOverlay: () => trackView?.toggleLookOverlay(),
    togglePreview: () => cameraDebug?.toggle() ?? false,
    calibrating: () => trackView?.calibrating ?? false,
  });
  reapplyManual = controls.reapply;

  // Controls: read from the devices themselves while the app runs, so posing
  // the face does not need the window (or the user's attention).
  const setOrigin = setupGazeControls(gaze, settings);
  // The dock's settings and the fold live in one module; the restart path is
  // handed in, because only this file holds the canvas and the rig.
  installSettingsPanel(settings, { reconnect: () => applyOutput(app, rig, settings), setOrigin });
  shell.fillInputHint();
  void startInput();
  // The first-run steps. Tauri only: the preview has no devices to set up. Opened
  // before the stream is claimed, so a fresh config lands in the wizard, not in
  // an error panel over a dead canvas.
  if (isTauri) installWizard(settings, () => (mouth ? { state: mouth.state, error: mouth.error } : null));

  // Two ways to pose the face, sharing one rig. Switching re-applies whichever
  // side takes over instead of leaving the other side's pose on the bones.
  subscribeMode((mode) => {
    if (mode === "track") {
      trackView?.enter();
    } else {
      trackView?.leave();
    }
    shell.applyModeUi(mode);
  });
  shell.applyModeUi(faceMode());

  // Eye tracking: manual mode follows the pointer or a pinned screen corner;
  // camera mode is driven by the tracker's readings.
  gaze.start();
  app.ticker.add(() => {
    const dt = app.ticker.deltaMS / 1000;
    // The backdrop's aurora is the only part of the look that moves on its own.
    rig.backdrop.update(dt);
    if (faceMode() === "manual") {
      const point = gaze.update(dt);
      rig.setGaze(point.u, point.v);
      return;
    }
    trackView?.tick(rig, dt);
  });

  // In the browser there is no desktop cursor to read, and on Wayland outside
  // Hyprland the backend has none either; the pointer over the canvas covers
  // both.
  shell.canvas.addEventListener("pointermove", (event) => {
    const bounds = shell.canvas.getBoundingClientRect();
    gaze.pointerOver({
      u: (event.clientX - bounds.left) / bounds.width,
      v: (event.clientY - bounds.top) / bounds.height,
    });
  });

  if (!isTauri) {
    // Still wire the dock: folding is a layout setting, not a backend one, and
    // the browser preview is where the layout gets eyeballed.
    wireButtons();
    shell.setCalibrateAvailable(false);
    shell.setHud("preview", "browser preview — the camera bridge needs the Tauri window");
    return;
  }

  installStream(isTauri, settings, {
    mic: () => (mouth ? { state: mouth.state, error: mouth.error } : null),
    calibrated: (kind) => tracker.done.has(kind),
    calibrating: () => trackView?.calibrating ?? false,
    gaze: () => ({ label: gaze.label, source: gaze.source }),
    lowLightGain: () => lowLight.gain,
    faceFailed: (error) => trackView?.faceFailed(error),
    faceHint: () => trackView?.showHint(),
  });

  await startStream(app, rig.skeleton);
  wireButtons();
  window.addEventListener("beforeunload", () => {
    // Best effort: a setting changed in the last debounce window should not be
    // the one that goes missing on quit.
    void settings.save();
    void stopStreaming();
  });

  await connect();
  window.setInterval(() => void refreshStatus(), 1000);

  // The setting decides how the app opens; `VIICELL_MODE=track bun run tauri dev`
  // still wins, because the env var is the power-user override for one run.
  const startMode = (await startupFaceMode()) ?? settings.value("startMode");
  if (startMode === "track") {
    setFaceMode("track");
  }
}

/** The panel's own buttons: retry, copy a fix, dismiss, the calibrations. */
function wireButtons(): void {
  shell.retryButton.addEventListener("click", () => void connect());
  shell.errorCopy.addEventListener("click", () => void shell.copyErrorFix());
  shell.errorDismiss.addEventListener("click", () => shell.dismissProblem());
  shell.inputHintCopy.addEventListener("click", () => void shell.copyInputFix());
  for (const button of shell.calibrateButtons) {
    button.addEventListener("click", () =>
      trackView?.startCalibration(button.dataset.calibration as CalibrationKind),
    );
  }
  shell.calibrationNext.addEventListener("click", () => trackView?.advanceCalibration());
  shell.calibrationCancel.addEventListener("click", () => {
    tracker.cancelCalibration();
    trackView?.closeCalibration();
  });
}

/** Gives the camera and the streaming device back, in either mode. */
function stopStreaming(): void {
  void stopCamera();
  void stopFaceCamera().catch(() => {});
}

void boot();
