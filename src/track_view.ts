import { invoke } from "@tauri-apps/api/core";
import { FACE_TRACKING } from "./config";
import { type CalibrationKind, lookTarget } from "./face/calibration";
import type { CameraDebugView } from "./face/debug_view";
import type { LowLight } from "./face/lowlight";
import type { FaceRig } from "./face/rig";
import type { FaceTracker } from "./face/tracker";
import type { FaceTracking } from "./face/tracking";
import { nextFaceFrame, startFaceCamera, stopFaceCamera } from "./face_camera";
import type { Gaze } from "./gaze";
import { faceMode, setFaceMode } from "./mode";
import * as shell from "./shell";

/**
 * Camera mode: the tracking camera, the whole-monitor crosshair, and the
 * step-by-step calibration.
 *
 * These three belong together because they share one rule: what the eyes are
 * doing is only meaningful once the camera has measured it, so a run that has no
 * camera must not leave marks on screen that claim to know where it looks. The
 * class owns that state; `./stream` and `./controls` only ask it questions.
 */

export interface TrackViewDeps {
  /** The native window exists: a browser has no camera bridge and no fullscreen. */
  isTauri: boolean;
  rig: FaceRig;
  tracker: FaceTracker;
  lowLight: LowLight;
  tracking: FaceTracking;
  gaze: Gaze;
  /** The camera preview canvas; null in a browser preview. */
  preview: () => CameraDebugView | null;
  /** Puts the manual pose back on the rig after the tracker posed it. */
  reapplyManual: () => void;
}

export class TrackView {
  #calibrating = false;
  /** Whether the `G` gaze crosshair is up. */
  #gazeOverlay = false;
  /** Whether the window is in fullscreen because of the look overlay. */
  #fullscreen = false;
  /**
   * Whether the window is confirmed to be the whole monitor, so a position in
   * it is a monitor position. The marks are only drawn once this is true.
   */
  #mapped = false;
  /** Whether the fullscreen request failed; the run falls back to the bezel. */
  #unavailable = false;
  /** Whether the preview was on before the calibration opened it. */
  #previewBefore = false;
  /** A one-off panel message that wins over the live status for a moment. */
  #notice = { text: "", at: 0 };

  /** Why tracking is not running, if it is not; shown under the HUD. */
  #faceError: string | null = null;
  /** Guards against starting a second tracking pull while one is in flight. */
  #busy = false;
  #lastTrackAt = 0;
  /** Last message shown in the tracking hint, so the console is not spammed. */
  #lastHint: string | null = null;

  constructor(private readonly deps: TrackViewDeps) {}

  get calibrating(): boolean {
    return this.#calibrating;
  }

  get faceError(): string | null {
    return this.#faceError;
  }

  /** The mode switched to tracking: open the camera and the model. */
  enter(): void {
    this.deps.preview()?.showMessage(shell.CAMERA_WAITING_MESSAGE);
    void this.begin();
  }

  /**
   * The mode left tracking: give the camera back, forget the failure, and put
   * the manual pose back on the bones the tracker was moving.
   */
  leave(): void {
    if (this.#calibrating) {
      this.deps.tracker.cancelCalibration();
      this.closeCalibration();
    }
    void stopFaceCamera().catch(() => {});
    this.#faceError = null;
    this.deps.preview()?.showMessage(shell.CAMERA_OFF_MESSAGE);
    this.showHint();
    this.deps.rig.setEyesFrozen(false);
    this.deps.tracking.reset(this.deps.rig);
    this.deps.reapplyManual();
    // The crosshair is a tracked-gaze readout; it has nothing to show here.
    this.#gazeOverlay = false;
    this.syncLookOverlay();
  }

  /**
   * Starts the camera and the landmark model.
   *
   * Both take a moment (the camera opens, the model compiles its WASM), so they
   * run together. A failure leaves the app in tracking mode with a neutral face
   * and says why under the HUD; `R` retries.
   */
  async begin(): Promise<void> {
    this.#faceError = null;
    this.deps.preview()?.showMessage(shell.CAMERA_WAITING_MESSAGE);
    this.showHint();
    this.deps.rig.setEyesFrozen(false);
    this.deps.tracking.reset(this.deps.rig);

    if (!this.deps.isTauri) {
      this.#faceError = "the camera bridge needs the Tauri window";
      this.showHint();
      return;
    }

    // A fresh mode start must not claim the camera for a mode that is no longer
    // showing; the calibration itself is kept, so re-entering fresh is instant.
    this.#lastTrackAt = 0;

    const [camera, model] = await Promise.allSettled([
      startFaceCamera(),
      this.deps.tracker.start(),
    ]);
    if (camera.status === "rejected") {
      this.#faceError = String(camera.reason);
      // The webcam is the device the person just asked for, so its failure gets
      // the panel — with the command that frees it — not just the small hint.
      shell.showError(camera.reason, "face-camera");
    } else if (model.status === "rejected") {
      this.#faceError = this.deps.tracker.error ?? String(model.reason);
    }

    // The mode may have flipped back while the camera was opening; do not leave
    // it claimed for a mode that is no longer showing.
    if (faceMode() !== "track") {
      if (camera.status === "fulfilled") {
        void stopFaceCamera().catch(() => {});
      }
      return;
    }

    this.showHint();
  }

  /** A failed status poll says so under the HUD, without the console spam. */
  faceFailed(error: string): void {
    this.#faceError = error;
    this.showHint();
  }

  /** Repaints the hint under the HUD from whatever is wrong right now. */
  showHint(): void {
    const message = this.#faceError ?? this.deps.tracker.error;
    if (message !== this.#lastHint) {
      this.#lastHint = message;
      shell.setTrackHint(message);
    }

    if (message !== null) {
      // The preview and the calibration prompt are both about a working camera.
      // Closing is outside the message check: a repeated error must still take
      // the panel down, or it would sit there with no frames and no way forward.
      if (this.#calibrating) {
        this.deps.tracker.cancelCalibration();
        this.closeCalibration();
      }
      this.deps.preview()?.showMessage(message);
    }
  }

  /** One animation frame in camera mode: ease, place the marks, read the camera. */
  tick(rig: FaceRig, dt: number): void {
    this.deps.tracking.update(rig, dt, this.deps.gaze.anchor);
    this.updateLookOverlay();
    void this.pump();
  }

  /**
   * Whether the full-monitor look overlay should be up.
   *
   * Two things want it: the `G` crosshair, and the pupil calibration, whose
   * corner marks have to sit where the fit says they are.
   */
  #overlayWanted(): boolean {
    return this.#gazeOverlay || (this.#calibrating && this.deps.tracker.progress.kind === "pupils");
  }

  /**
   * Shows or hides the overlay, and takes the window fullscreen with it.
   *
   * The marks are positions on the monitor, so the window has to be the whole
   * monitor for them to land where they claim. Leaving fullscreen puts the window
   * back how the window manager had it.
   */
  syncLookOverlay(): void {
    const wanted = this.#overlayWanted();
    if (!this.deps.isTauri) {
      // A browser has no window manager to go fullscreen; window units it is.
      this.#mapped = wanted;
    }

    // Nothing is drawn until the window is known to be the monitor. A failed
    // fullscreen (an older backend, no support) leaves the run on the physical
    // corners rather than putting the crosshair in a place it does not mean.
    const shown = wanted && this.#mapped;
    shell.lookOverlay.setVisible(shown);
    shell.setLooking(shown);
    shell.setRowActive("look", this.#gazeOverlay);

    if (wanted === this.#fullscreen) {
      return;
    }
    this.#fullscreen = wanted;

    if (!this.deps.isTauri) {
      return;
    }

    if (!wanted) {
      this.#mapped = false;
      this.#unavailable = false;
      void invoke("set_fullscreen", { fullscreen: false }).catch(() => {});
      return;
    }

    void invoke("set_fullscreen", { fullscreen: true })
      .then(() => {
        if (!this.#fullscreen) {
          return;
        }
        this.#mapped = true;
        this.#unavailable = false;
        this.syncLookOverlay();
      })
      .catch(() => {
        if (!this.#fullscreen) {
          return;
        }
        this.#mapped = false;
        this.#unavailable = true;
        this.syncLookOverlay();
      });
  }

  /** Places the crosshair and the calibration mark for the current frame. */
  updateLookOverlay(): void {
    if (!shell.lookOverlay.visible) {
      return;
    }

    shell.lookOverlay.setTarget(
      this.#calibrating && this.#mapped ? lookTarget(this.deps.tracker.progress.step) : null,
    );

    // The rig's own eased gaze: what the face is doing, which is what is being
    // judged. Before the first pupil run it stays centred, like the pupils.
    const pose = this.deps.tracking.pose;
    shell.lookOverlay.setCrosshair(
      faceMode() === "track" && this.#mapped
        ? { u: (pose.lookX + 1) / 2, v: (pose.lookY + 1) / 2 }
        : null,
    );
  }

  /** Toggles the tracked-gaze crosshair; tracking mode only. */
  toggleLookOverlay(): void {
    if (faceMode() !== "track") {
      return;
    }
    this.#gazeOverlay = !this.#gazeOverlay;
    this.syncLookOverlay();
  }

  /**
   * Opens the step-by-step calibration, with the tracking camera inside the panel.
   *
   * The calibration already in use stays live until the new one is finished, so a
   * cancelled run changes nothing.
   */
  startCalibration(kind: CalibrationKind = "mouth"): void {
    if (!this.deps.isTauri) {
      return;
    }

    // Pressing a button again while the panel is open restarts that part of the
    // poses instead of reopening everything.
    if (this.#calibrating) {
      this.deps.tracker.beginCalibration(kind);
      this.renderCalibration();
      this.syncLookOverlay();
      return;
    }

    // The camera only runs in tracking mode, so the button behaves like switching
    // to it; a camera that failed earlier is retried on the way.
    if (faceMode() !== "track") {
      setFaceMode("track");
    } else if (this.#faceError !== null || !this.deps.tracker.ready) {
      void this.begin();
    }

    this.deps.tracker.beginCalibration(kind);
    this.#calibrating = true;
    this.#previewBefore = this.deps.preview()?.visible ?? false;
    this.deps.preview()?.setVisible(true);
    shell.setRowActive("debug", true);
    shell.openCalibrationPanel();
    this.#notice = { text: "", at: 0 };
    this.renderCalibration();
    this.syncLookOverlay();
  }

  /** Redraws the panel from the pose the tracker is collecting. */
  renderCalibration(): void {
    if (!this.#calibrating) {
      return;
    }

    const progress = this.deps.tracker.progress;
    if (progress.step === null) {
      this.closeCalibration();
      return;
    }

    // Without a confirmed fullscreen the marks would sit at window positions, not
    // monitor ones, so the run falls back to the bezel with the old instruction.
    const bezel =
      this.#unavailable && progress.kind === "pupils" && progress.step !== "neutral";
    const fresh = performance.now() - this.#notice.at < 900;

    shell.paintCalibration({
      kindLabel: progress.label || "Face",
      count: `${progress.index}/${progress.total}`,
      text: bezel
        ? "Look at that corner of the monitor itself — restart the app for the on-screen marks"
        : progress.instruction,
      fillPercent: Math.round(progress.filled * 100),
      note:
        fresh && this.#notice.text
          ? this.#notice.text
          : !progress.armed
            ? "press Start when you are ready"
            : progress.settling
              ? "settling into the pose…"
              : progress.samples === 0
                ? "waiting for the camera…"
                : progress.ready
                  ? "measured — press Next"
                  : progress.hint,
      nextLabel: !progress.armed
        ? "Start"
        : progress.index === progress.total
          ? "Finish"
          : "Next",
    });
  }

  /** Stores the pose on screen and moves to the next one. */
  advanceCalibration(): void {
    const progress = this.deps.tracker.progress;
    if (progress.step === null) {
      this.closeCalibration();
      return;
    }

    // Nothing is recorded until Start: the pose is read only once the person says
    // they are in it, so a pose is never captured while they are still settling.
    if (!progress.armed) {
      this.deps.tracker.startCalibrationPose();
      this.renderCalibration();
      return;
    }

    // The button stays live on purpose: a click that cannot move on says why,
    // instead of being swallowed by a disabled control.
    if (!progress.ready) {
      this.#notice = {
        text: progress.settling
          ? "settling — hold the pose…"
          : progress.samples === 0
            ? "waiting for the camera…"
            : progress.hint,
        at: performance.now(),
      };
      this.renderCalibration();
      return;
    }

    this.deps.tracker.nextCalibrationStep();
    this.renderCalibration();
  }

  /** Closes the panel and puts the preview back where it was. */
  closeCalibration(): void {
    this.#calibrating = false;
    shell.closeCalibrationPanel();
    this.#notice = { text: "", at: 0 };

    const preview = this.deps.preview();
    preview?.setVisible(this.#previewBefore);
    shell.setRowActive("debug", preview?.visible ?? false);
    this.syncLookOverlay();
  }

  /**
   * Pulls one camera frame and runs the landmark model on it.
   *
   * The camera's own thread is the producer, so a frame is only requested when
   * the previous model run has finished: the tracker can never build a backlog of
   * stale pictures. Between runs the rig eases towards the last reading.
   */
  async pump(): Promise<void> {
    const now = performance.now();
    if (!this.deps.isTauri || !this.deps.tracker.ready || this.#busy || this.#faceError !== null) {
      return;
    }
    if (now - this.#lastTrackAt < FACE_TRACKING.intervalMs) {
      return;
    }
    this.#lastTrackAt = now;
    this.#busy = true;

    try {
      const frame = await nextFaceFrame();
      if (frame.byteLength === 0) {
        // The camera is still opening, or has stopped; status says which.
        return;
      }

      const bitmap = await createImageBitmap(new Blob([frame], { type: "image/jpeg" }));
      const picture = this.deps.lowLight.prepare(bitmap);
      try {
        const reading = this.deps.tracker.detect(picture, performance.now());
        this.renderCalibration();
        // The preview draws the very picture the model just saw, so the outlines
        // and the pose always belong together.
        if (faceMode() === "track") {
          this.deps.preview()?.draw(picture, reading);
        }
        this.deps.tracking.set(reading?.sample ?? null);
      } finally {
        bitmap.close();
      }
    } catch (error) {
      this.#faceError = String(error);
      this.showHint();
    } finally {
      this.#busy = false;
    }
  }
}
