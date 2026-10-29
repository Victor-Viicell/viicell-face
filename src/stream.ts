import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { type Application, type Container } from "pixi.js";
import { cameraStatus, pushFrame, startCamera } from "./camera";
import { BACKGROUND } from "./config";
import { classify, type AppError } from "./errors";
import type { CalibrationKind } from "./face/calibration";
import { faceCameraStatus } from "./face_camera";
import { statusChips, type FaceNote, type MicNote } from "./hud";
import { keysAreGlobal } from "./input";
import { faceMode } from "./mode";
import type { SettingsStore } from "./settings";
import * as shell from "./shell";

/**
 * The frame path and the health poll: the half of the app that talks to the
 * backend.
 *
 * `pumpFrame` is the hot path — it runs at the output rate and must not
 * allocate, log or await anything but the push. Everything it needs is read off
 * module scope, so a frame is one compare, one `performance.now()` and one
 * `invoke`.
 */

/** What the stream needs to know about the rest of the app. */
export interface StreamSources {
  /** The microphone, or null before it has been created. */
  mic: () => { state: string; error: string | null } | null;
  /** Whether a calibration kind has been measured, for the attention marks. */
  calibrated: (kind: CalibrationKind) => boolean;
  /** Whether the step-by-step calibration panel is open. */
  calibrating: () => boolean;
  /** Where the eyes read the screen from, for the status line. */
  gaze: () => { label: string; source: string };
  /** The low-light gain currently applied to the tracked frame. */
  lowLightGain: () => number;
  /** The tracking camera reported a failure; the panel may want to say it. */
  faceFailed: (error: string) => void;
  /** Something about the tracking camera changed; repaint the hint. */
  faceHint: () => void;
}

let installed: { isTauri: boolean; settings: SettingsStore; sources: StreamSources } | null = null;

/** Whether frames should be shipped to the virtual camera right now. */
let streaming = false;
/** Guards against queueing frames faster than the backend can take them. */
let pushing = false;
let lastPush = 0;
let frameInterval = 1000 / 30;

/** Called once at boot, before anything can poll or push. */
export function installStream(
  isTauri: boolean,
  settings: SettingsStore,
  sources: StreamSources,
): void {
  installed = { isTauri, settings, sources };
}

function deps() {
  if (installed === null) {
    throw new Error("installStream() must run before the stream is used");
  }
  return installed;
}

/**
 * Hands rendering to the backend's ticker and starts pushing frames.
 *
 * Rendering is driven by the backend instead of requestAnimationFrame: rAF
 * waits on compositor frame callbacks, and a window on another workspace gets
 * none, which drops the face to about 1 fps and freezes the camera there.
 */
export async function startStream(app: Application, overlay: Container): Promise<void> {
  const { settings } = deps();
  app.ticker.stop();
  void invoke("set_tick_rate", { fps: settings.value("output").fps });

  const captureFrame = createFrameSource(app, overlay);
  await listen("frame-tick", () => {
    // Runs every animation callback (mouth, blinks, gaze) and the renderer,
    // then reads the canvas back for the camera.
    app.ticker.update(performance.now());
    pumpFrame(captureFrame);
  });
}

/** Claims the loopback device at the size and rate the settings ask for. */
export async function connect(): Promise<void> {
  const { isTauri, settings } = deps();
  if (!isTauri) {
    return;
  }

  streaming = false;
  shell.hideError();
  // An explicit retry is also permission to speak: a failure dismissed earlier
  // must be able to show itself again if it is still there.
  shell.clearDismissed();
  shell.setHud("starting", "looking for a virtual camera…");

  // Whatever the store holds now — after boot it is the saved config.
  const output = settings.value("output");
  frameInterval = 1000 / output.fps;

  try {
    const info = await startCamera(output.width, output.height, output.fps);
    streaming = true;
    // The claim, not the measurement: `startCamera` echoes what the device was
    // asked for. The first status poll (≤ 1 s) replaces this line with the chip
    // row, which is the measured rate, the real drops and the devices.
    shell.setHud(
      "live",
      `${info.device.label} · ${info.device.path} · ${info.width}×${info.height} ${info.pixelFormat} · ${info.fps} fps`,
    );
  } catch (error) {
    shell.showError(error);
  }
}

/**
 * Sends at most `fps` frames per second, and only one at a time so a slow frame
 * never piles up a backlog of stale pictures.
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

/** Reads the backend once a second and says how the stream is doing. */
export async function refreshStatus(): Promise<void> {
  const { sources } = deps();
  // The keys need read access to the input devices, which only a udev rule can
  // grant; until the backend opens one, say so instead of leaving the HUD's
  // `keys window` unexplained.
  shell.setInputHint(keysAreGlobal());

  try {
    const status = await cameraStatus();

    if (status.error) {
      streaming = false;
      shell.showError(status.error);
      return;
    }

    if (!status.running || !status.info) {
      streaming = false;
      shell.setHud("idle", "camera stopped");
      return;
    }

    const { device, width, height, pixelFormat } = status.info;
    // In camera mode the eyes are not reading the cursor, so say what is
    // actually driving the face, and how the tracking camera is doing.
    const trackingMode = faceMode() === "track";
    let face: FaceNote = { kind: "off" };
    // The tracking camera outranks the microphone: it is the device the person
    // just asked for, so its failure is the one the panel talks about.
    let faceProblem: AppError | null = null;
    if (trackingMode) {
      try {
        const camera = await faceCameraStatus();
        if (camera.error) {
          sources.faceFailed(camera.error);
          faceProblem = classify(camera.error, "face-camera");
          sources.faceHint();
        }
        face = camera.info
          ? {
              kind: "info",
              width: camera.info.width,
              height: camera.info.height,
              frames: camera.frames,
              failed: camera.error !== null,
            }
          : { kind: "starting" };
      } catch {
        face = { kind: "unknown" };
      }
    }

    // Nothing follows a part of the face until it has been measured once, so
    // point at the button that does it.
    shell.paintCalibrationAttention(
      trackingMode,
      sources.calibrating(),
      sources.calibrated,
    );

    shell.setHudChips(
      statusChips({
        tracking: trackingMode,
        device: { label: device.label, path: device.path },
        width,
        height,
        pixelFormat,
        fps: status.fps,
        framesReceived: status.framesReceived,
        framesDropped: status.framesDropped,
        gaze: sources.gaze(),
        keysGlobal: keysAreGlobal(),
        mic: micNote(sources.mic()),
        face,
        lowLightGain: trackingMode ? sources.lowLightGain() : 0,
      }),
    );

    // The camera is healthy (the checks above returned otherwise), so whatever
    // still deserves the panel is the tracking camera or the microphone. Last,
    // so a failure keeps the HUD in its error colour instead of being painted
    // over by the `live` line the healthy stream just set.
    shell.setPanelProblem(faceProblem ?? micProblem());
  } catch (error) {
    streaming = false;
    shell.setHud("error", "cannot reach the camera backend");
    shell.showError(error);
  }
}

/** How the mic note reads: silent while it works, honest while it does not. */
function micNote(mic: { state: string; error: string | null } | null): MicNote {
  if (mic === null || mic.state === "live") {
    return null;
  }
  return mic.state === "unavailable" ? "off" : "waiting";
}

/**
 * The microphone's current failure, if it has one.
 *
 * The mic is optional — without it the synth line just draws its resting bars —
 * so a live mic clears the panel and the "already dismissed" marks with it,
 * which is what lets a second failure be announced after a fix.
 */
function micProblem(): AppError | null {
  const mic = deps().sources.mic();
  if (mic === null) return null;
  if (mic.state === "live") {
    shell.forgetDismissed("mic_missing", "mic_denied");
    return null;
  }
  if (mic.state === "unavailable" && mic.error !== null) return classify(mic.error, "mic");
  return null;
}
