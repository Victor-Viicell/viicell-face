/**
 * The status row, as a pure function.
 *
 * Everything that measures the stream lives in `./stream`; this file turns one
 * snapshot of those numbers into the chips at the foot of the dock — one chip
 * per fact, each carrying its own state and the fix that would change it. No
 * DOM, no clock, no Tauri bridge, so `bun test` covers every rule with no
 * window and no device.
 *
 * Two rules the row depends on:
 *
 * - **The order and the count are fixed.** The painter reuses one node per
 *   `key`, so a chip that vanished would reflow the row under the reader. A
 *   state with nothing to say says so (`face —`) instead of disappearing.
 * - **The label is the value; the tooltip is the source or the fix.** Hovering
 *   a yellow or grey chip must tell a person the one command that changes it,
 *   which is why the fix strings come from `./errors` rather than being
 *   rewritten here.
 *
 * Sources, one per chip: `mode` ← `stream.ts` asks `faceMode()`; `device`,
 * `fps`, `dropped` ← `camera_status` (the Rust writer's own counters);
 * `mic` ← the mouth's state; `face` ← `face_camera_status`; `keys` ← whether
 * the udev rule let the backend open `/dev/input`; `origin` ← the gaze's
 * anchor and cursor source.
 */

import { MIC_FIX, inputDenied } from "./errors";

/** How the microphone is doing, as far as the row cares. */
export type MicNote = "waiting" | "off" | null;

/** What the tracking camera's line says. */
export type FaceNote =
  | { kind: "off" }
  | { kind: "starting" }
  | { kind: "unknown" }
  | { kind: "info"; width: number; height: number; frames: number; failed: boolean };

export interface StatusSnapshot {
  /** Camera mode reads the face; manual mode reads the cursor and keys. */
  tracking: boolean;
  device: { label: string; path: string };
  width: number;
  height: number;
  pixelFormat: string;
  /** Frames per second actually written to the loopback device. */
  fps: number;
  framesReceived: number;
  framesDropped: number;
  gaze: { label: string; source: string };
  keysGlobal: boolean;
  /** `null` when the microphone is live or has not started. */
  mic: MicNote;
  face: FaceNote;
  /** Low-light gain applied to the tracked frame; ≤ 1.05 says nothing. */
  lowLightGain: number;
}

/** How a chip reads: fine, worth a look, or not there at all. */
export type ChipState = "ok" | "warn" | "off";

/**
 * Everything a chip's key can be, in paint order.
 *
 * The union is the point: `shell.ts` keys its nodes by it, and a typo in a key
 * is a type error rather than a chip that appears twice at runtime.
 */
export type ChipKey = "mode" | "device" | "fps" | "dropped" | "mic" | "face" | "keys" | "origin";

export interface Chip {
  key: ChipKey;
  /** What the chip says. Short: eight of these have to fit a 295 px foot. */
  label: string;
  state: ChipState;
  /** Where the number came from, or the command that fixes it. Shown on hover. */
  tooltip: string;
}

/**
 * Below this the output is visibly stuttering.
 *
 * A call wants 15–30 fps; under 20 the loopback writer or the compositor is the
 * limit, not the face, and the person should be told while it happens rather
 * than after the call.
 */
export const FPS_WARN_BELOW = 20;

/** The keys fix, from the one module allowed to know commands. */
const INPUT_FIX = inputDenied().fix ?? "sudo scripts/setup-input-access.sh";

function modeChip(tracking: boolean): Chip {
  // The key is written out rather than imported from `./mode`, which pulls in
  // the Tauri bridge; this file stays importable by a plain `bun test`.
  return tracking
    ? {
        key: "mode",
        label: "track",
        state: "ok",
        tooltip: "the webcam drives the face: press M to go back to the keys and the cursor",
      }
    : {
        key: "mode",
        label: "manual",
        state: "ok",
        tooltip: "the keys and the cursor drive the face: press M to track from the webcam",
      };
}

function deviceChip(snapshot: StatusSnapshot): Chip {
  const { device, width, height, pixelFormat } = snapshot;
  return {
    key: "device",
    label: `${device.label} ${width}×${height} ${pixelFormat}`,
    state: "ok",
    tooltip: `${device.path} · the virtual camera this app writes to`,
  };
}

function fpsChip(snapshot: StatusSnapshot): Chip {
  const rate = snapshot.fps.toFixed(0);
  if (snapshot.fps >= FPS_WARN_BELOW) {
    return {
      key: "fps",
      label: `${rate} fps`,
      state: "ok",
      tooltip: `measured over the last second · ${snapshot.framesReceived} frames in`,
    };
  }
  if (snapshot.fps > 0) {
    return {
      key: "fps",
      label: `${rate} fps`,
      state: "warn",
      tooltip:
        "below the 20 fps a call needs: close other capture apps, or ask for a " +
        "smaller output size in settings.json",
    };
  }
  return {
    key: "fps",
    label: "0 fps",
    state: "off",
    tooltip: "no frame has reached the device: the camera backend is not writing yet",
  };
}

function droppedChip(snapshot: StatusSnapshot): Chip {
  const { framesDropped, framesReceived } = snapshot;
  if (framesDropped === 0) {
    return {
      key: "dropped",
      label: "0 dropped",
      state: "ok",
      tooltip: `${framesReceived} frames in, none dropped`,
    };
  }
  return {
    key: "dropped",
    label: `${framesDropped} dropped`,
    state: "warn",
    tooltip:
      `${framesDropped} of ${framesReceived} frames were skipped because a push ` +
      "outran the frame: close other capture apps, or ask for a lower output rate",
  };
}

function micChip(note: MicNote): Chip {
  if (note === null) {
    return {
      key: "mic",
      label: "mic live",
      state: "ok",
      tooltip: "the microphone is open: the mouth follows the room",
    };
  }
  if (note === "waiting") {
    return {
      key: "mic",
      label: "mic waiting",
      state: "warn",
      tooltip: "the microphone has not opened yet: allow it in the system dialog",
    };
  }
  return {
    key: "mic",
    label: "mic off",
    state: "off",
    tooltip: `no microphone: the mouth draws its resting bars — ${MIC_FIX}`,
  };
}

function faceChip(face: FaceNote, tracking: boolean, lowLightGain: number): Chip {
  if (!tracking) {
    // The tracker never opened a camera in this mode; saying "off" would read
    // like a failure, so the chip says there is nothing to track from.
    return {
      key: "face",
      label: "face —",
      state: "off",
      tooltip: "facial track is off: press M to drive the face from the webcam",
    };
  }

  switch (face.kind) {
    case "off":
      return {
        key: "face",
        label: "face off",
        state: "off",
        tooltip: "the tracking camera is not running: the panel says why",
      };
    case "unknown":
      // The poll itself failed; the frames and the lift are unknown with it.
      return {
        key: "face",
        label: "face ?",
        state: "warn",
        tooltip: "the status poll failed: the backend did not answer",
      };
    case "starting":
      return {
        key: "face",
        label: "face starting",
        state: "warn",
        tooltip: "opening the webcam…",
      };
    case "info": {
      const size = `${face.width}×${face.height}`;
      if (face.failed) {
        return {
          key: "face",
          label: `face ${size} off`,
          state: "off",
          tooltip: "the webcam stopped: close the app holding it, then press R to retry",
        };
      }
      // The lift is a diagnostic, not a headline: it belongs where the frame
      // count is, and only when the stage actually changed the picture.
      const lift = lowLightGain > 1.05 ? ` · lift ×${lowLightGain.toFixed(1)}` : "";
      return {
        key: "face",
        label: `face ${size} ${face.frames} fr`,
        state: "ok",
        tooltip: `the webcam driving the eyes: ${face.frames} frames read${lift}`,
      };
    }
  }
}

function keysChip(keysGlobal: boolean): Chip {
  return keysGlobal
    ? {
        key: "keys",
        label: "keys global",
        state: "ok",
        tooltip: "every key on the desktop drives the face",
      }
    : {
        key: "keys",
        label: "keys window",
        state: "warn",
        tooltip: `keys only work while this window has focus — ${INPUT_FIX}`,
      };
}

function originChip(gaze: { label: string; source: string }): Chip {
  if (gaze.source === "monitor") {
    return {
      key: "origin",
      label: `origin ${gaze.label}`,
      state: "ok",
      tooltip: "the cursor is read from the whole monitor",
    };
  }
  if (gaze.source === "window") {
    return {
      key: "origin",
      label: `origin ${gaze.label}`,
      state: "warn",
      tooltip:
        "no desktop cursor (Hyprland only): the pointer over the stage is the aim, " +
        "and it snaps back to the origin when it leaves",
    };
  }
  return {
    key: "origin",
    label: `origin ${gaze.label}`,
    state: "off",
    tooltip: "no cursor source yet: move the pointer over the stage",
  };
}

/** The row's chips, in paint order. Fixed count, fixed order, no DOM. */
export function statusChips(snapshot: StatusSnapshot): Chip[] {
  return [
    modeChip(snapshot.tracking),
    deviceChip(snapshot),
    fpsChip(snapshot),
    droppedChip(snapshot),
    micChip(snapshot.mic),
    faceChip(snapshot.face, snapshot.tracking, snapshot.lowLightGain),
    keysChip(snapshot.keysGlobal),
    originChip(snapshot.gaze),
  ];
}
