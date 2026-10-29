/**
 * The app's error vocabulary.
 *
 * Rust reports failures as plain sentences (`"no v4l2loopback device found; run
 * …"`), and those sentences are the only thing that reaches the webview. This
 * module turns them into one {@link AppError}: a stable `code` a session can
 * branch on, a headline a person can read, the raw text for a bug report, and
 * — the point of the whole thing — the one command that fixes it.
 *
 * Nothing here touches the DOM, Tauri or the clock, so `bun test` covers every
 * rule with no window and no device.
 */

/** What went wrong, in terms the app acts on. Never shown to a person. */
export type ErrorCode =
  | "device_missing"
  | "device_busy"
  | "device_invalid"
  | "device_denied"
  | "camera_missing"
  | "camera_busy"
  | "camera_denied"
  | "mic_missing"
  | "mic_denied"
  | "format_unsupported"
  | "input_denied"
  | "gstreamer_missing"
  | "backend_unreachable"
  | "unknown";

/**
 * Which device the failure came from.
 *
 * The virtual camera and the tracking camera both open `/dev/videoN` and both
 * say "busy" when they cannot, so the string alone cannot tell them apart. The
 * call site knows, so it says — that is the only reason this exists.
 */
export type ErrorSource = "camera" | "face-camera" | "mic" | "input";

/** One failure, ready to render: headline, raw detail, and how to fix it. */
export interface AppError {
  code: ErrorCode;
  /** One short line. What is wrong, in the product's own voice. */
  message: string;
  /** The failure text verbatim (trimmed), so a bug report can be searched. */
  detail: string;
  /** The single command that fixes it, copyable. Absent when none can. */
  fix?: string;
}

interface Rule {
  /** Only applies to this source; omitted means every source. */
  source?: ErrorSource;
  test: RegExp;
  code: ErrorCode;
  message: string;
  fix?: string;
}

/**
 * The one command that has ever brought a dead PipeWire microphone back.
 *
 * Exported because the status row's mic chip shows the fix on hover without
 * going through `classify()` — the row has a state, not a failure, and must not
 * invent a second copy of the command.
 */
export const MIC_FIX = "systemctl --user restart wireplumber";

const SETUP_CAMERA = "sudo scripts/setup-virtual-camera.sh";
const FIND_HOLDER = "sudo fuser -v /dev/video*";
const SETUP_INPUT = "sudo scripts/setup-input-access.sh";
const JOIN_VIDEO = "sudo usermod -aG video $USER";

/**
 * The whole classification, in priority order.
 *
 * Order matters and is deliberate: a failure is often several true statements
 * at once ("cannot open /dev/video0: Device or resource busy" is both a device
 * problem and a busy one), and the more specific rule has to win — a hint about
 * which command to run beats a restatement of the syscall that failed.
 */
const RULES: readonly Rule[] = [
  {
    test: /no v4l2loopback device found/i,
    code: "device_missing",
    message: "no virtual camera device on this machine",
    fix: SETUP_CAMERA,
  },
  {
    test: /VIICELL_\w+=.*(could not be opened|not a usable)/i,
    code: "device_invalid",
    message: "the device you pinned is not usable",
    fix: "unset VIICELL_VIDEO_DEVICE VIICELL_FACE_DEVICE",
  },
  {
    source: "face-camera",
    test: /no camera found/i,
    code: "camera_missing",
    message: "no webcam found",
  },
  {
    source: "mic",
    test: /no microphone found/i,
    code: "mic_missing",
    message: "no microphone found",
  },
  {
    test: /(read the microphone format|unsupported microphone sample format|invalid frame size|invalid frame rate|cannot capture MJPG|cannot start streaming)/i,
    code: "format_unsupported",
    message: "this device cannot do the format the app asked for",
  },
  {
    test: /\/dev\/input/,
    code: "input_denied",
    message: "keys only work while this window has focus",
    fix: SETUP_INPUT,
  },
  {
    source: "mic",
    test: /microphone/i,
    code: "mic_denied",
    message: "the microphone would not open",
    fix: MIC_FIX,
  },
  {
    // Ordering inside this pair is the whole reason `source` exists.
    source: "face-camera",
    test: /(busy|resource temporarily unavailable|timed out)/i,
    code: "camera_busy",
    message: "the webcam is held by another program",
    fix: FIND_HOLDER,
  },
  {
    test: /(busy|resource temporarily unavailable|timed out)/i,
    code: "device_busy",
    message: "the virtual camera is held by another program",
    fix: FIND_HOLDER,
  },
  {
    source: "face-camera",
    test: /permission denied|operation not permitted|not permitted/i,
    code: "camera_denied",
    message: "no permission for the webcam",
    fix: JOIN_VIDEO,
  },
  {
    test: /permission denied|operation not permitted|not permitted/i,
    code: "device_denied",
    message: "no permission for the video device",
    fix: JOIN_VIDEO,
  },
  {
    test: /(cannot reach the camera backend|needs the Tauri window)/i,
    code: "backend_unreachable",
    message: "the native backend is not answering",
  },
  {
    test: /gstreamer/i,
    code: "gstreamer_missing",
    message: "the media stack is incomplete",
    fix: "sudo pacman -S --needed gst-plugins-good gst-libav",
  },
];

/** Turns whatever a `catch` caught into the text Rust (or JS) put in it. */
function rawText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error === null || error === undefined) return "";
  if (error instanceof Error) return error.message || String(error);
  if (typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  try {
    return String(error);
  } catch {
    return "";
  }
}

/**
 * Collapses whitespace so a multi-line Rust message still fits one line, and an
 * empty payload keeps its meaning ("something failed, with no explanation").
 */
function tidy(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const CODES = new Set<ErrorCode>([
  "device_missing",
  "device_busy",
  "device_invalid",
  "device_denied",
  "camera_missing",
  "camera_busy",
  "camera_denied",
  "mic_missing",
  "mic_denied",
  "format_unsupported",
  "input_denied",
  "gstreamer_missing",
  "backend_unreachable",
  "unknown",
]);

/** Whether a value is already a classified error worth passing through. */
export function isAppError(value: unknown): value is AppError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AppError>;
  return (
    typeof candidate.code === "string" &&
    CODES.has(candidate.code as ErrorCode) &&
    typeof candidate.message === "string" &&
    typeof candidate.detail === "string"
  );
}

/**
 * Maps a failure into the taxonomy.
 *
 * Already-classified errors pass through untouched, so a caller may hand a
 * classified value to something that classifies again without losing the fix.
 * Anything unrecognised becomes `unknown` rather than being dropped: an
 * unexplained failure still needs a panel.
 */
export function classify(error: unknown, source: ErrorSource = "camera"): AppError {
  if (isAppError(error)) return error;

  const detail = tidy(rawText(error));
  for (const rule of RULES) {
    if (rule.source && rule.source !== source) continue;
    if (!rule.test.test(detail)) continue;
    const mapped: AppError = { code: rule.code, message: rule.message, detail };
    if (rule.fix) mapped.fix = rule.fix;
    return mapped;
  }

  return {
    code: "unknown",
    message: "something failed on the device side",
    detail: detail.length > 0 ? detail : "the backend gave no reason",
  };
}

/**
 * The failure that is not a failure: the keys work, but only while this window
 * has focus, because nothing granted read access to `/dev/input`.
 *
 * Built here so the panel and the hint say the same thing, and so the
 * `udev_rule` class has one home. It is not an error — the app is usable — so
 * it is rendered as a hint with the fix, never as a blocking panel.
 */
export function inputDenied(): AppError {
  return {
    code: "input_denied",
    message: "keys only work while this window has focus",
    detail: "the app was not granted read access to /dev/input/event*",
    fix: SETUP_INPUT,
  };
}
