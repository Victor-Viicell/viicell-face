/**
 * The camera output configuration.
 *
 * One set of numbers drives all three consumers, so keep them in sync:
 * the PixiJS canvas buffer, the frame pump and the v4l2 device format.
 *
 * These are the *defaults* only. The numbers the app actually runs with live in
 * the settings store (`./settings`), which merges the saved file over them at
 * boot; `OUTPUT` stays as the fallback for anything that needs a size before the
 * store has loaded, so the default has one source of truth (failure bank #53).
 */
import { DEFAULT_SETTINGS } from "./settings";

export const OUTPUT = DEFAULT_SETTINGS.output;

/** Colour of the (still empty) canvas; also used as the extract background. */
export const BACKGROUND = "#11111b";

/**
 * Facial tracking resources.
 *
 * Both are files under `public/`: the MediaPipe WASM runtime (copied from
 * `@mediapipe/tasks-vision`) and the FaceLandmarker model. Keeping them local
 * means the app works offline and never fetches a model at startup.
 */
export const FACE_TRACKING = {
  wasmPath: "/mediapipe/wasm",
  modelPath: "/models/face_landmarker.task",
  /** Milliseconds between landmark runs; matches the 30 frame/s camera. */
  intervalMs: 30,
} as const;
