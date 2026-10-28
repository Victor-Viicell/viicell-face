/**
 * Which source poses the face.
 *
 * - `manual`: the key controls and the cursor, as the app has always worked.
 * - `track`: the webcam, via MediaPipe face landmarks.
 *
 * Iris size and pupil width stay on the manual keys in both modes.
 */

import { invoke } from "@tauri-apps/api/core";

export type FaceMode = "manual" | "track";

/** Toggles the mode. Behind the mouse side button like every other key. */
export const MODE_KEY = "m";
/** Re-measures the neutral pose, or retries the camera when it failed. */
export const RECENTRE_KEY = "r";

let current: FaceMode = "manual";
const listeners = new Set<(mode: FaceMode) => void>();

export function faceMode(): FaceMode {
  return current;
}

export function setFaceMode(mode: FaceMode): void {
  if (mode === current) {
    return;
  }
  current = mode;
  for (const listener of listeners) {
    listener(mode);
  }
}

export function toggleFaceMode(): void {
  setFaceMode(current === "manual" ? "track" : "manual");
}

export function subscribeMode(listener: (mode: FaceMode) => void): void {
  listeners.add(listener);
}

/** `VIICELL_MODE=track` opens the app already tracking. */
export async function startupFaceMode(): Promise<FaceMode | null> {
  try {
    const mode = await invoke<string | null>("startup_mode");
    return mode === "track" || mode === "manual" ? mode : null;
  } catch {
    return null;
  }
}
