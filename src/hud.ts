/**
 * The status line, as a pure function.
 *
 * Everything that measures the stream lives in `./stream`; this file only turns
 * a snapshot of those numbers into the one line under the canvas. Keeping it
 * pure is what lets the text be tested without a browser, and it is the part
 * the chip row (VF-011) replaces — so it stays small on purpose.
 */

/** How the microphone is doing, as far as the line cares. */
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

/** Tells the reader where the tracked eyes come from and how the camera is. */
function faceNote(face: FaceNote, tracking: boolean, lowLightGain: number): string {
  if (!tracking) {
    // The low-light stage only runs on tracked frames; there is nothing to say.
    return "";
  }

  let note: string;
  switch (face.kind) {
    case "off":
      return "";
    case "unknown":
      // The poll itself failed; the lift is unknown too, so do not guess it.
      return " · face ?";
    case "starting":
      note = " · face starting";
      break;
    case "info":
      note = ` · face ${face.width}×${face.height}${
        face.failed ? " off" : ` ${face.frames} fr`
      }`;
      break;
  }

  // Only worth saying when the low-light stage actually changed the frame.
  if (lowLightGain > 1.05) {
    note += ` · lift ×${lowLightGain.toFixed(1)}`;
  }
  return note;
}

/** The HUD's live line: mode, device, format, measured rate, inputs, devices. */
export function statusLine(snapshot: StatusSnapshot): string {
  const { device, gaze } = snapshot;
  // `monitor` vs `window` says where the eyes get their cursor from; `window`
  // also means the keys only work while this window has focus. The camera mode
  // still names the origin, since the keys move the face there too.
  const eyes = snapshot.tracking
    ? `eyes camera·${gaze.label}`
    : `eyes ${gaze.label}·${gaze.source}`;
  const keys = snapshot.keysGlobal ? "global" : "window";
  const mode = snapshot.tracking ? "mode track" : "mode manual";
  const mic = snapshot.mic === null ? "" : ` · mic ${snapshot.mic}`;

  return (
    `${mode} · ${device.label} · ${device.path} · ${snapshot.width}×${snapshot.height} ` +
    `${snapshot.pixelFormat} · ${snapshot.fps.toFixed(0)} fps · ` +
    `${snapshot.framesReceived} in · ${snapshot.framesDropped} dropped · ${eyes} · ` +
    `keys ${keys}${mic}${faceNote(snapshot.face, snapshot.tracking, snapshot.lowLightGain)}`
  );
}
