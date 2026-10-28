import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface MicrophoneStatus {
  running: boolean;
  device: string | null;
  sampleRate: number | null;
  error: string | null;
}

export function microphoneStatus(): Promise<MicrophoneStatus> {
  return invoke<MicrophoneStatus>("microphone_status");
}

/**
 * Subscribes to the waveform frames produced by the Rust capture thread.
 *
 * The payload is one byte per point with 128 as the zero line, which is the
 * same shape `AnalyserNode.getByteTimeDomainData` would give.
 */
export function onMicWave(handler: (waveform: number[]) => void): Promise<UnlistenFn> {
  return listen<number[]>("mic-wave", (event) => handler(event.payload));
}
