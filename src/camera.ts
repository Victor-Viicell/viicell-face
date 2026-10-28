import { invoke } from "@tauri-apps/api/core";

export interface VideoDevice {
  path: string;
  label: string;
  driver: string;
  /** v4l2loopback style device: the only kind we can stream into. */
  isLoopback: boolean;
  canOutput: boolean;
}

export interface CameraInfo {
  device: VideoDevice;
  width: number;
  height: number;
  /** Output rate the device is kept at. */
  fps: number;
  pixelFormat: string;
}

export interface CameraStatus {
  running: boolean;
  info: CameraInfo | null;
  framesReceived: number;
  framesDropped: number;
  framesWritten: number;
  /** Frames per second actually written to the device. */
  fps: number;
  error: string | null;
}

/** Every video device on the machine, loopback and physical. */
export function listVideoDevices(): Promise<VideoDevice[]> {
  return invoke<VideoDevice[]>("list_video_devices");
}

/** Claims a loopback device and starts streaming into it. */
export function startCamera(width: number, height: number, fps: number): Promise<CameraInfo> {
  return invoke<CameraInfo>("start_camera", { width, height, fps });
}

export function stopCamera(): Promise<void> {
  return invoke<void>("stop_camera");
}

export function cameraStatus(): Promise<CameraStatus> {
  return invoke<CameraStatus>("camera_status");
}

/**
 * Sends one RGBA frame.
 *
 * Passing the typed array as the whole payload makes Tauri send a raw
 * octet-stream body instead of JSON, which is what keeps 1280×720 frames cheap.
 */
export function pushFrame(rgba: Uint8Array): Promise<void> {
  return invoke<void>("push_frame", rgba);
}
