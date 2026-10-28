import { Application, type Container } from "pixi.js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { cameraStatus, pushFrame, startCamera, stopCamera } from "./camera";
import { BACKGROUND, FACE_TRACKING, OUTPUT } from "./config";
import { ARTBOARD, MOUTH } from "./face/art";
import { CameraDebugView } from "./face/debug_view";
import { LowLight } from "./face/lowlight";
import { SynthMouth } from "./face/mouth";
import { FaceRig } from "./face/rig";
import { FaceTracker } from "./face/tracker";
import { FaceTracking } from "./face/tracking";
import { faceCameraStatus, nextFaceFrame, startFaceCamera, stopFaceCamera } from "./face_camera";
import { GAZE_ANCHORS, Gaze } from "./gaze";
import { keysAreGlobal, startInput, subscribeInput } from "./input";
import {
  MODE_KEY,
  RECENTRE_KEY,
  faceMode,
  setFaceMode,
  startupFaceMode,
  subscribeMode,
  toggleFaceMode,
  type FaceMode,
} from "./mode";

type HudState = "starting" | "live" | "idle" | "error" | "preview";

const canvas = document.querySelector<HTMLCanvasElement>("#output")!;
const hud = document.querySelector<HTMLElement>("#hud")!;
const hudText = document.querySelector<HTMLElement>("#hud-text")!;
const errorPanel = document.querySelector<HTMLElement>("#error-panel")!;
const errorText = document.querySelector<HTMLElement>("#error-text")!;
const retryButton = document.querySelector<HTMLButtonElement>("#retry")!;
const inputHint = document.querySelector<HTMLElement>("#input-hint")!;
const trackHint = document.querySelector<HTMLElement>("#track-hint")!;
const calibrationPanel = document.querySelector<HTMLElement>("#calibration")!;
const calibrationCount = document.querySelector<HTMLElement>("#calibration-count")!;
const calibrationText = document.querySelector<HTMLElement>("#calibration-text")!;
const calibrationNote = document.querySelector<HTMLElement>("#calibration-note")!;
const calibrationFill = document.querySelector<HTMLElement>("#calibration-fill")!;
const calibrationCamera = document.querySelector<HTMLElement>("#calibration-camera")!;
const calibrationNext = document.querySelector<HTMLButtonElement>("#calibration-next")!;
const calibrationCancel = document.querySelector<HTMLButtonElement>("#calibration-cancel")!;
const calibrateButton = document.querySelector<HTMLButtonElement>("#calibrate")!;
const debugCanvas = document.querySelector<HTMLCanvasElement>("#debug-camera");
const leanRow = document.querySelector<HTMLElement>("#lean-row");
const debugRow = document.querySelector<HTMLElement>("#debug-row");
const modeName = document.querySelector<HTMLElement>("#mode-name")!;
const modeRow = document.querySelector<HTMLElement>("#mode-row");

const isTauri = "__TAURI_INTERNALS__" in window;

/** Whether frames should be shipped to the virtual camera right now. */
let streaming = false;
/** Guards against queueing frames faster than the backend can take them. */
let pushing = false;
let lastPush = 0;
const frameInterval = 1000 / OUTPUT.fps;

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
/** Whether the step-by-step calibration panel is open. */
let calibrating = false;
/** Whether the preview was on before the calibration opened it. */
let previewBeforeCalibration = false;
/** A one-off panel message that wins over the live status for a moment. */
let calibrationNotice = { text: "", at: 0 };

/** Why tracking is not running, if it is not; shown under the HUD. */
let faceCameraError: string | null = null;
/** Guards against starting a second tracking pull while one is in flight. */
let trackingBusy = false;
let lastTrackAt = 0;
/** Last message shown in the tracking hint, so the console is not spammed. */
let lastTrackHint: string | null = null;

async function boot() {
  const app = new Application();
  await app.init({
    canvas,
    width: OUTPUT.width,
    height: OUTPUT.height,
    background: BACKGROUND,
    antialias: true,
    resolution: 1,
    autoDensity: false,
    preference: "webgl",
    powerPreference: "high-performance",
  });

  // The face rig is the canvas the camera broadcasts. Posing a bone
  // (`rig.bones.eyeLeftIris.moveBy(...)`) shows up in the next frame.
  const rig = new FaceRig(OUTPUT.width / ARTBOARD.width);
  app.stage.addChild(rig.root);

  // A DOM canvas over the face, so the preview can never be read back into the
  // virtual camera's frames.
  cameraDebug = debugCanvas ? new CameraDebugView(debugCanvas) : null;
  cameraDebug?.showMessage(
    faceMode() === "track" ? "waiting for the camera…" : CAMERA_OFF_MESSAGE,
  );

  // The synth line is a spectrum display: the microphone drives its rods along
  // the bottom edge of the face.
  mouth = new SynthMouth();
  rig.bones.synth.node.addChild(mouth.view);
  void mouth.start();
  app.ticker.add(() => mouth?.update());

  const controls = setupFaceControls(app, rig);

  // Controls: read from the devices themselves while the app runs, so posing
  // the face does not need the window (or the user's attention).
  setupGazeControls();
  void startInput();

  // Two ways to pose the face, sharing one rig. Switching re-applies whichever
  // side takes over instead of leaving the other side's pose on the bones.
  subscribeMode((mode) => {
    if (mode === "track") {
      cameraDebug?.showMessage("waiting for the camera…");
      void beginTracking(rig);
    } else {
      if (calibrating) {
        tracker.cancelCalibration();
        closeCalibration();
      }
      void stopFaceCamera().catch(() => {});
      faceCameraError = null;
      cameraDebug?.showMessage(CAMERA_OFF_MESSAGE);
      showTrackHint();
      rig.setEyesFrozen(false);
      tracking.reset(rig);
      controls.reapply();
    }
    applyModeUi(mode);
  });
  applyModeUi(faceMode());

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

    tracking.update(rig, dt, gaze.anchor);
    void pumpTracking();
  });

  // In the browser there is no desktop cursor to read, and on Wayland outside
  // Hyprland the backend has none either; the pointer over the canvas covers
  // both.
  canvas.addEventListener("pointermove", (event) => {
    const bounds = canvas.getBoundingClientRect();
    gaze.pointerOver({
      u: (event.clientX - bounds.left) / bounds.width,
      v: (event.clientY - bounds.top) / bounds.height,
    });
  });

  if (!isTauri) {
    calibrateButton.hidden = true;
    setHud("preview", "browser preview — the camera bridge needs the Tauri window");
    return;
  }

  // Rendering is driven by the backend instead of requestAnimationFrame: rAF
  // waits on compositor frame callbacks, and a window on another workspace gets
  // none, which drops the face to about 1 fps and freezes the camera there.
  app.ticker.stop();
  void invoke("set_tick_rate", { fps: OUTPUT.fps });

  const captureFrame = createFrameSource(app, rig.skeleton);
  await listen("frame-tick", () => {
    // Runs every animation callback (mouth, blinks, gaze) and the renderer,
    // then reads the canvas back for the camera.
    app.ticker.update(performance.now());
    pumpFrame(captureFrame);
  });

  retryButton.addEventListener("click", () => void connect());
  calibrateButton.addEventListener("click", () => startCalibration(rig));
  calibrationNext.addEventListener("click", () => advanceCalibration());
  calibrationCancel.addEventListener("click", () => {
    tracker.cancelCalibration();
    closeCalibration();
  });
  window.addEventListener("beforeunload", () => {
    void stopCamera();
    void stopFaceCamera().catch(() => {});
  });

  await connect();
  window.setInterval(refreshStatus, 1000);

  // `VIICELL_MODE=track bun run tauri dev` opens straight into tracking, which
  // is handy when the keys are not at hand yet.
  const startMode = await startupFaceMode();
  if (startMode === "track") {
    setFaceMode("track");
  }
}

/**
 * Sends at most `OUTPUT.fps` frames per second, and only one at a time so a
 * slow frame never piles up a backlog of stale pictures.
 */
function pumpFrame(captureFrame: () => Uint8Array) {
  if (!streaming || pushing) {
    return;
  }

  const now = performance.now();
  // The ticks already run at the output rate; the slack absorbs the jitter of a
  // timer-driven loop, so a full rate of frames still goes out.
  if (now - lastPush < frameInterval - 8) {
    return;
  }
  lastPush = now;

  pushing = true;
  pushFrame(captureFrame())
    .catch(() => {
      // Real failures show up in the status poll, with a useful message.
    })
    .finally(() => {
      pushing = false;
    });
}

/**
 * Reads the rendered canvas as RGBA bytes.
 *
 * The skeleton overlay is hidden for the readback: it is a rigging aid and must
 * never leak into what other apps capture.
 */
function createFrameSource(app: Application, overlay: Container): () => Uint8Array {
  return () => {
    const overlayWasVisible = overlay.visible;
    overlay.visible = false;

    try {
      const { pixels } = app.renderer.extract.pixels({
        target: app.stage,
        frame: app.screen,
        clearColor: BACKGROUND,
      });
      return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    } finally {
      overlay.visible = overlayWasVisible;
    }
  };
}

async function connect() {
  if (!isTauri) {
    return;
  }

  streaming = false;
  hideError();
  setHud("starting", "looking for a virtual camera…");

  try {
    const info = await startCamera(OUTPUT.width, OUTPUT.height, OUTPUT.fps);
    streaming = true;
    setHud(
      "live",
      `${info.device.label} · ${info.device.path} · ${info.width}×${info.height} ${info.pixelFormat} · ${info.fps} fps`,
    );
  } catch (error) {
    showError(String(error));
  }
}

async function refreshStatus() {
  // The keys need read access to the input devices, which only a udev rule can
  // grant; until the backend opens one, say so instead of leaving the HUD's
  // `keys window` unexplained.
  inputHint.hidden = keysAreGlobal();

  try {
    const status = await cameraStatus();

    if (status.error) {
      streaming = false;
      showError(status.error);
      return;
    }

    if (!status.running || !status.info) {
      streaming = false;
      setHud("idle", "camera stopped");
      return;
    }

    hideError();
    const { device, width, height, pixelFormat } = status.info;
    const micNote =
      mouth && mouth.state !== "live"
        ? ` · mic ${mouth.state === "unavailable" ? "off" : "waiting"}`
        : "";

    // In camera mode the eyes are not reading the cursor, so say what is
    // actually driving the face, and how the tracking camera is doing.
    const trackingMode = faceMode() === "track";
    let faceNote = "";
    if (trackingMode) {
      try {
        const face = await faceCameraStatus();
        if (face.error) {
          faceCameraError = face.error;
          showTrackHint();
        }
        if (face.info) {
          faceNote = ` · face ${face.info.width}×${face.info.height}${face.error ? " off" : ` ${face.frames} fr`}`;
        } else {
          faceNote = " · face starting";
        }
      } catch {
        faceNote = " · face ?";
      }
      // Only worth saying when the low-light stage actually changed the frame.
      if (lowLight.gain > 1.05) {
        faceNote += ` · lift ×${lowLight.gain.toFixed(1)}`;
      }
    }

    // `monitor` vs `window` says where the eyes get their cursor from; `window`
    // also means the keys only work while this window has focus. The camera
    // mode still names the origin, since the keys move the face there too.
    const eyes = trackingMode ? `eyes camera·${gaze.label}` : `eyes ${gaze.label}·${gaze.source}`;
    const keys = keysAreGlobal() ? "global" : "window";
    const mode = trackingMode ? "mode track" : "mode manual";
    // Nothing follows the face until it has been measured once, so point at the
    // button that does it.
    calibrateButton.classList.toggle(
      "attention",
      trackingMode && !calibrating && !tracker.progress.calibrated,
    );
    setHud(
      "live",
      `${mode} · ${device.label} · ${device.path} · ${width}×${height} ${pixelFormat} · ` +
        `${status.fps.toFixed(0)} fps · ${status.framesReceived} in · ` +
        `${status.framesDropped} dropped · ${eyes} · keys ${keys}${micNote}${faceNote}`,
    );
  } catch (error) {
    streaming = false;
    setHud("error", "cannot reach the camera backend");
    showError(String(error));
  }
}

function setHud(state: HudState, text: string) {
  hud.dataset.state = state;
  hudText.textContent = text;
}

function applyModeUi(mode: FaceMode) {
  document.body.dataset.mode = mode;
  modeName.textContent = mode === "track" ? "facial track" : "manual";
  modeRow?.classList.toggle("active", mode === "track");
  leanRow?.classList.remove("active");
}

/**
 * Starts the camera and the landmark model.
 *
 * Both take a moment (the camera opens, the model compiles its WASM), so they
 * run together. A failure leaves the app in tracking mode with a neutral face
 * and says why under the HUD; `R` retries.
 */
async function beginTracking(rig: FaceRig) {
  faceCameraError = null;
  cameraDebug?.showMessage("waiting for the camera…");
  showTrackHint();
  rig.setEyesFrozen(false);
  tracking.reset(rig);

  if (!isTauri) {
    faceCameraError = "the camera bridge needs the Tauri window";
    showTrackHint();
    return;
  }

  // A fresh mode start must not claim the camera for a mode that is no longer
  // showing; the calibration itself is kept, so re-entering fresh is instant.
  lastTrackAt = 0;

  const [camera, model] = await Promise.allSettled([startFaceCamera(), tracker.start()]);
  if (camera.status === "rejected") {
    faceCameraError = String(camera.reason);
  } else if (model.status === "rejected") {
    faceCameraError = tracker.error ?? String(model.reason);
  }

  // The mode may have flipped back while the camera was opening; do not leave it
  // claimed for a mode that is no longer showing.
  if (faceMode() !== "track") {
    if (camera.status === "fulfilled") {
      void stopFaceCamera().catch(() => {});
    }
    return;
  }

  showTrackHint();
}

function showTrackHint() {
  const message = faceCameraError ?? tracker.error;
  if (message !== lastTrackHint) {
    lastTrackHint = message;
    trackHint.hidden = message === null;
    trackHint.textContent = message === null ? "" : `facial track: ${message}`;
    if (message !== null) {
      console.warn(`viicell-face: ${message}`);
    }
  }

  if (message !== null) {
    // The preview and the calibration prompt are both about a working camera.
    // Closing is outside the message check: a repeated error must still take
    // the panel down, or it would sit there with no frames and no way forward.
    if (calibrating) {
      tracker.cancelCalibration();
      closeCalibration();
    }
    cameraDebug?.showMessage(message);
  }
}

/**
 * Opens the step-by-step calibration, with the tracking camera inside the panel.
 *
 * The calibration already in use stays live until the new one is finished, so a
 * cancelled run changes nothing.
 */
function startCalibration(rig: FaceRig) {
  if (!isTauri) {
    return;
  }

  // Pressing the key again while the panel is open restarts the poses instead of
  // reopening everything.
  if (calibrating) {
    tracker.beginCalibration();
    renderCalibration();
    return;
  }

  // The camera only runs in tracking mode, so the button behaves like switching
  // to it; a camera that failed earlier is retried on the way.
  if (faceMode() !== "track") {
    setFaceMode("track");
  } else if (faceCameraError !== null || !tracker.ready) {
    void beginTracking(rig);
  }

  tracker.beginCalibration();
  calibrating = true;
  previewBeforeCalibration = cameraDebug?.visible ?? false;
  cameraDebug?.setVisible(true);
  debugRow?.classList.toggle("active", true);

  if (debugCanvas) {
    calibrationCamera.append(debugCanvas);
  }

  calibrateButton.hidden = true;
  calibrationPanel.hidden = false;
  calibrationNotice = { text: "", at: 0 };
  renderCalibration();
}

/** Redraws the panel from the pose the tracker is collecting. */
function renderCalibration() {
  if (!calibrating) {
    return;
  }

  const progress = tracker.progress;
  if (progress.step === null) {
    closeCalibration();
    return;
  }

  calibrationCount.textContent = `${progress.index}/${progress.total}`;
  calibrationText.textContent = progress.instruction;
  calibrationFill.style.width = `${Math.round(progress.filled * 100)}%`;

  const fresh = performance.now() - calibrationNotice.at < 900;
  calibrationNote.textContent =
    fresh && calibrationNotice.text
      ? calibrationNotice.text
      : !progress.armed
        ? "press Start when you are ready"
        : progress.settling
          ? "settling into the pose…"
          : progress.samples === 0
            ? "waiting for the camera…"
            : progress.ready
              ? "measured — press Next"
              : progress.hint;
  calibrationNext.textContent = !progress.armed
    ? "Start"
    : progress.index === progress.total
      ? "Finish"
      : "Next";
}

/** Stores the pose on screen and moves to the next one. */
function advanceCalibration() {
  const progress = tracker.progress;
  if (progress.step === null) {
    closeCalibration();
    return;
  }

  // Nothing is recorded until Start: the pose is read only once the person says
  // they are in it, so a pose is never captured while they are still settling.
  if (!progress.armed) {
    tracker.startCalibrationPose();
    renderCalibration();
    return;
  }

  // The button stays live on purpose: a click that cannot move on says why,
  // instead of being swallowed by a disabled control.
  if (!progress.ready) {
    calibrationNotice = {
      text: progress.settling
        ? "settling — hold the pose…"
        : progress.samples === 0
          ? "waiting for the camera…"
          : progress.hint,
      at: performance.now(),
    };
    renderCalibration();
    return;
  }

  tracker.nextCalibrationStep();
  renderCalibration();
}

/** Closes the panel and puts the preview back where it was. */
function closeCalibration() {
  calibrating = false;
  calibrationPanel.hidden = true;
  calibrateButton.hidden = false;
  calibrationNotice = { text: "", at: 0 };

  if (debugCanvas) {
    document.body.append(debugCanvas);
  }
  cameraDebug?.setVisible(previewBeforeCalibration);
  debugRow?.classList.toggle("active", cameraDebug?.visible ?? false);
}

/**
 * Pulls one camera frame and runs the landmark model on it.
 *
 * The camera's own thread is the producer, so a frame is only requested when
 * the previous model run has finished: the tracker can never build a backlog of
 * stale pictures. Between runs the rig eases towards the last reading.
 */
async function pumpTracking() {
  const now = performance.now();
  if (!isTauri || !tracker.ready || trackingBusy || faceCameraError !== null) {
    return;
  }
  if (now - lastTrackAt < FACE_TRACKING.intervalMs) {
    return;
  }
  lastTrackAt = now;
  trackingBusy = true;

  try {
    const frame = await nextFaceFrame();
    if (frame.byteLength === 0) {
      // The camera is still opening, or has stopped; status says which.
      return;
    }

    const bitmap = await createImageBitmap(new Blob([frame], { type: "image/jpeg" }));
    const picture = lowLight.prepare(bitmap);
    try {
      const reading = tracker.detect(picture, performance.now(), gaze.cursor);
      renderCalibration();
      // The preview draws the very picture the model just saw, so the outlines
      // and the pose always belong together.
      if (faceMode() === "track") {
        cameraDebug?.draw(picture, reading);
      }
      tracking.set(reading?.sample ?? null);
    } finally {
      bitmap.close();
    }
  } catch (error) {
    faceCameraError = String(error);
    showTrackHint();
  } finally {
    trackingBusy = false;
  }
}

function showError(message: string) {
  errorText.textContent = message;
  errorPanel.hidden = false;
  setHud("error", "virtual camera unavailable");
}

function hideError() {
  errorPanel.hidden = true;
}

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
/** What the preview says while the camera is not running. */
const CAMERA_OFF_MESSAGE = "camera off · manual mode";
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
function setupFaceControls(app: Application, rig: FaceRig): { reapply: () => void } {
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
        startCalibration(rig);
      }
      return;
    }

    if (input.type === "keydown" && input.name === "d") {
      // Joints, pivots and bone names, for rigging work.
      rig.skeleton.visible = !rig.skeleton.visible;
      return;
    }

    if (input.type === "keydown" && input.name === DEBUG_KEY) {
      if (calibrating) {
        // The calibration panel owns the preview while it is open.
        return;
      }
      // The camera the landmarker reads, with its landmarks over it.
      debugRow?.classList.toggle("active", cameraDebug?.toggle() ?? false);
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
      leanRow?.classList.toggle("active", frozen);
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
    leanRow?.classList.remove("active");
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
 */
function setupGazeControls() {
  let held = false;
  let picked = false;

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
          gaze.setOrigin("center");
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
    gaze.setOrigin(GAZE_ANCHORS[index]);
  });

  window.addEventListener("blur", () => {
    held = false;
  });
}

void boot();
