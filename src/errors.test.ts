import { describe, expect, test } from "bun:test";
import { classify, inputDenied, isAppError, type ErrorCode } from "./errors";

/**
 * The strings here are copied from `src-tauri/src/*.rs` on purpose: the point
 * of the taxonomy is that the exact sentences Rust sends today keep landing in
 * the right place. If a Rust message is reworded, the matching test fails and
 * the session that reworded it is the one that notices.
 */

const fix = (error: unknown, source?: Parameters<typeof classify>[1]) =>
  classify(error, source);

describe("virtual camera failures", () => {
  test("missing loopback device points at the setup script", () => {
    const error = fix(
      "no v4l2loopback device found; run `sudo scripts/setup-virtual-camera.sh` to create one",
    );
    expect(error.code).toBe("device_missing");
    expect(error.fix).toBe("sudo scripts/setup-virtual-camera.sh");
    expect(error.message).toBe("no virtual camera device on this machine");
    expect(error.detail).toContain("no v4l2loopback device found");
  });

  test("a pinned device that cannot be opened is not 'missing'", () => {
    const error = fix("VIICELL_VIDEO_DEVICE=/dev/video99 could not be opened as a video device");
    expect(error.code).toBe("device_invalid");
    expect(error.fix).toBe("unset VIICELL_VIDEO_DEVICE VIICELL_FACE_DEVICE");
  });

  test("a busy device says who to look for", () => {
    const error = fix("timed out while opening /dev/video11; the device may be busy");
    expect(error.code).toBe("device_busy");
    expect(error.fix).toBe("sudo fuser -v /dev/video*");
  });

  test("a refused open is a permission problem, not a busy one", () => {
    const error = fix("failed to open /dev/video11: Permission denied (os error 13)");
    expect(error.code).toBe("device_denied");
    expect(error.fix).toBe("sudo usermod -aG video $USER");
  });

  test("a rejected size is a format problem and offers no command", () => {
    const error = fix("invalid frame size 1281x720: YUYV needs non-zero, even dimensions");
    expect(error.code).toBe("format_unsupported");
    expect(error.fix).toBeUndefined();
  });
});

describe("tracking camera failures", () => {
  test("busy webcam is its own code, not the virtual camera's", () => {
    const error = fix("cannot open /dev/video0: Device or resource busy", "face-camera");
    expect(error.code).toBe("camera_busy");
    expect(error.message).toBe("the webcam is held by another program");
  });

  test("the same sentence from the virtual camera stays device_busy", () => {
    expect(fix("cannot open /dev/video0: Device or resource busy").code).toBe("device_busy");
  });

  test("no webcam found", () => {
    const error = fix("no camera found; plug one in or set VIICELL_FACE_DEVICE=/dev/videoN", "face-camera");
    expect(error.code).toBe("camera_missing");
    expect(error.fix).toBeUndefined();
  });

  test("a webcam without permission", () => {
    const error = fix("cannot open /dev/video0: Permission denied", "face-camera");
    expect(error.code).toBe("camera_denied");
    expect(error.fix).toBe("sudo usermod -aG video $USER");
  });

  test("a camera that cannot do MJPG", () => {
    const error = fix("/dev/video0 cannot capture MJPG 1280×720: Invalid argument", "face-camera");
    expect(error.code).toBe("format_unsupported");
  });
});

describe("microphone failures", () => {
  test("no microphone", () => {
    expect(fix("no microphone found", "mic").code).toBe("mic_missing");
  });

  test("a device that refuses to open offers a restart of the sound server", () => {
    const error = fix("cannot open the microphone: Device or resource busy", "mic");
    expect(error.code).toBe("mic_denied");
    expect(error.fix).toBe("systemctl --user restart wireplumber");
  });

  test("a timed-out open is the same class as a denied one", () => {
    expect(fix("timed out while opening the microphone", "mic").code).toBe("mic_denied");
  });

  test("a format the device cannot give is format, not permission", () => {
    expect(fix("cannot read the microphone format: Invalid argument", "mic").code).toBe(
      "format_unsupported",
    );
  });
});

describe("input permission", () => {
  test("the hint and the classifier agree", () => {
    const hint = inputDenied();
    const classified = fix("cannot open /dev/input/event3: Permission denied", "input");
    expect(classified.code).toBe(hint.code);
    expect(classified.fix).toBe(hint.fix);
    expect(classified.message).toBe(hint.message);
  });

  test("the hint carries the setup command", () => {
    expect(inputDenied().fix).toBe("sudo scripts/setup-input-access.sh");
    expect(inputDenied().detail).toContain("/dev/input");
  });
});

describe("everything else", () => {
  test("a dead backend is named as such", () => {
    expect(fix("cannot reach the camera backend").code).toBe("backend_unreachable");
    expect(fix("the camera bridge needs the Tauri window").code).toBe("backend_unreachable");
  });

  test("an Error object is read through its message", () => {
    const error = fix(new Error("no v4l2loopback device found"));
    expect(error.code).toBe("device_missing");
  });

  test("multi-line detail is folded onto one line", () => {
    const error = fix("cannot open the microphone:\n  permission   denied");
    expect(error.detail).toBe("cannot open the microphone: permission denied");
  });

  test("an unexplained failure still gets a panel", () => {
    const error = fix(null);
    expect(error.code).toBe("unknown");
    expect(error.message).toBe("something failed on the device side");
    expect(error.detail).toBe("the backend gave no reason");
  });

  test("an empty string is treated as no reason", () => {
    expect(fix("").detail).toBe("the backend gave no reason");
  });

  test("an unrecognised sentence keeps its text", () => {
    const error = fix("the camera state is poisoned");
    expect(error.code).toBe("unknown");
    expect(error.detail).toBe("the camera state is poisoned");
  });

  test("a classified error passes through instead of being re-read", () => {
    const once = fix("no v4l2loopback device found");
    const twice = fix(once, "face-camera");
    expect(twice).toBe(once);
    expect(twice.code).toBe("device_missing");
  });

  test("isAppError rejects lookalikes", () => {
    expect(isAppError({ code: "nope", message: "x", detail: "y" })).toBe(false);
    expect(isAppError({ code: "device_missing", message: "x" })).toBe(false);
    expect(isAppError("device_missing")).toBe(false);
    expect(isAppError(null)).toBe(false);
  });

  test("every code in the table is distinct enough to render", () => {
    const samples: Array<[string, ErrorCode, Parameters<typeof classify>[1]?]> = [
      ["no v4l2loopback device found", "device_missing"],
      ["VIICELL_VIDEO_DEVICE=/dev/null could not be opened as a video device", "device_invalid"],
      ["timed out while opening /dev/video11; the device may be busy", "device_busy"],
      ["failed to open /dev/video11: Permission denied", "device_denied"],
      ["no camera found; plug one in", "camera_missing", "face-camera"],
      ["no microphone found", "mic_missing", "mic"],
      ["gstreamer is not installed", "gstreamer_missing"],
    ];
    for (const [text, code, source] of samples) {
      expect(fix(text, source).code).toBe(code);
    }
  });
});
