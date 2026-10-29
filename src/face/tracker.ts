import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { FACE_TRACKING } from "../config";
import {
  CALIBRATION_PRESETS,
  CalibrationFlow,
  type CalibrationKind,
  type CalibrationProgress,
} from "./calibration";
import type { FrameSource } from "./lowlight";
import {
  NO_CALIBRATION,
  faceSample,
  readFace,
  type Calibration,
  type FaceSample,
  type Landmark,
  type RawSample,
} from "./landmarks";

export type { FaceSample };

/** One model run, with the measurements behind the pose. */
export interface TrackReading {
  /** The rig's units, after the calibration is applied. */
  sample: FaceSample;
  /** The measurement before the calibration is applied. */
  raw: RawSample;
  /** The 478 landmarks, 0..1 across the camera frame. */
  landmarks: Landmark[];
  /** Where the guided calibration is; `step` is null once it has finished. */
  calibration: CalibrationProgress;
}

/**
 * Reads a face from the tracking camera.
 *
 * MediaPipe's FaceLandmarker runs here in the webview (WASM + WebGL) rather
 * than in Rust: it gives per-eye lid closure, eye direction and head position in
 * one pass, which a hand-written CV pipeline would take a lot to match. The
 * frames themselves come from the native capture thread, so tracking keeps
 * working while the window is hidden.
 */
export class FaceTracker {
  #landmarker: FaceLandmarker | null = null;
  #starting: Promise<void> | null = null;
  #error: string | null = null;
  /** What the guided calibration measured; empty until it has run. */
  #calibration: Calibration = NO_CALIBRATION;
  #flow = new CalibrationFlow();
  /** Kinds finished in this session, for the buttons' prompts. */
  #done = new Set<CalibrationKind>();
  /** The preset currently running, so a finished run can be recorded. */
  #kind: CalibrationKind = "mouth";
  /** Monotonic timestamp the model expects. */
  #timestamp = 0;

  get ready(): boolean {
    return this.#landmarker !== null;
  }

  get error(): string | null {
    return this.#error;
  }

  /** Where the calibration is; `step` is null when it is not running. */
  get progress(): CalibrationProgress {
    return { ...this.#flow.progress, calibrated: this.#calibration.neutral.calibrated };
  }

  /** Which calibration runs have finished, so the buttons can prompt for the rest. */
  get done(): ReadonlySet<CalibrationKind> {
    return this.#done;
  }

  /** Loads the WASM runtime and the model. Safe to call repeatedly. */
  async start(): Promise<void> {
    if (this.#landmarker) {
      return;
    }
    if (this.#starting) {
      return this.#starting;
    }

    this.#error = null;
    this.#starting = (async () => {
      try {
        const fileset = await FilesetResolver.forVisionTasks(FACE_TRACKING.wasmPath);
        this.#landmarker = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: FACE_TRACKING.modelPath,
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numFaces: 1,
          outputFaceBlendshapes: true,
          // The head pose comes from the landmarks, so the matrix would only
          // cost inference time.
          outputFacialTransformationMatrixes: false,
        });
      } catch (error) {
        this.#error = String(error);
        throw error;
      } finally {
        this.#starting = null;
      }
    })();

    return this.#starting;
  }

  /**
   * Runs the model on one camera frame. Returns null when no face is visible;
   * call it at most as often as the camera produces frames.
   */
  detect(source: FrameSource, nowMs: number): TrackReading | null {
    const landmarker = this.#landmarker;
    if (!landmarker) {
      return null;
    }

    // The model rejects repeated timestamps, which a stopped camera can hand out.
    const timestamp = Math.max(nowMs, this.#timestamp + 1);
    this.#timestamp = timestamp;

    const result = landmarker.detectForVideo(source, timestamp);
    const landmarks = result.faceLandmarks[0];
    const shapes = result.faceBlendshapes[0]?.categories;
    if (!landmarks || !shapes) {
      return null;
    }

    const raw = readFace(landmarks, shapes, source.width / source.height);
    if (!raw) {
      return null;
    }

    // The flow collects this pose while it runs, and ignores it otherwise.
    this.#flow.add(raw);

    return {
      sample: faceSample(raw, this.#calibration),
      raw,
      landmarks,
      calibration: this.progress,
    };
  }

  /**
   * Starts one part of the step-by-step calibration. The current pose keeps
   * responding on the calibration in use until the new one is finished, and a
   * run only replaces the channels it measures.
   */
  beginCalibration(kind: CalibrationKind = "mouth"): void {
    this.#kind = kind;
    this.#flow.restart(CALIBRATION_PRESETS[kind], this.#calibration);
  }

  /** Begins collecting the pose on screen; nothing is read before it. */
  startCalibrationPose(): void {
    this.#flow.start();
  }

  /** Stores the pose that was held and moves on; returns the finished one. */
  nextCalibrationStep(): Calibration | null {
    const calibration = this.#flow.next();
    if (calibration) {
      this.#calibration = calibration;
      this.#done.add(this.#kind);
    }
    return calibration;
  }

  cancelCalibration(): void {
    this.#flow.cancel();
  }

  close(): void {
    this.#landmarker?.close();
    this.#landmarker = null;
    this.#flow.cancel();
  }
}
