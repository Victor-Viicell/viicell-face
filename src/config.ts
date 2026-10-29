/**
 * The camera output configuration.
 *
 * One set of numbers drives all three consumers, so keep them in sync:
 * the PixiJS canvas buffer, the frame pump and the v4l2 device format.
 */
export const OUTPUT = {
  /** 16:9, and the largest size the recommended v4l2loopback setup accepts. */
  width: 1280,
  height: 720,
  /** Frames pushed per second. Higher values cost IPC bandwidth linearly. */
  fps: 30,
} as const;

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
