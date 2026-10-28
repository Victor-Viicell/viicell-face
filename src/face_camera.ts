import { invoke } from "@tauri-apps/api/core";

/** The webcam the facial-tracking mode captures from. */
export interface FaceCameraInfo {
  path: string;
  label: string;
  width: number;
  height: number;
  fps: number;
}

export interface FaceCameraStatus {
  running: boolean;
  info: FaceCameraInfo | null;
  /** Frames captured since the camera was opened. */
  frames: number;
  error: string | null;
}

/** Opens the tracking camera; it stays open until `stopFaceCamera`. */
export function startFaceCamera(): Promise<FaceCameraInfo> {
  return invoke<FaceCameraInfo>("start_face_camera");
}

/** Gives the camera back to other apps. */
export function stopFaceCamera(): Promise<void> {
  return invoke<void>("stop_face_camera");
}

export function faceCameraStatus(): Promise<FaceCameraStatus> {
  return invoke<FaceCameraStatus>("face_camera_status");
}

/**
 * The newest JPEG frame, or an empty buffer before the first one arrives.
 *
 * The command answers with a raw body instead of JSON, so this resolves to an
 * `ArrayBuffer` — no base64 and no per-byte JSON array.
 */
export async function nextFaceFrame(): Promise<ArrayBuffer> {
  const body = await invoke<ArrayBuffer | number[]>("face_frame");
  if (body instanceof ArrayBuffer) {
    return body;
  }
  return new Uint8Array(body).buffer;
}
