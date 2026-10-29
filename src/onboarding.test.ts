import { describe, expect, test } from "bun:test";
import { MIC_FIX, deviceMissing, inputDenied } from "./errors";
import {
  STEP_COPY,
  STEP_ORDER,
  cameraFailure,
  canBroadcast,
  captureDevice,
  firstUnready,
  loopbackDevice,
  needsWizard,
  readyCount,
  type DeviceFact,
  type OnboardingFacts,
  wizardSteps,
} from "./onboarding";

const LOOPBACK: DeviceFact = {
  path: "/dev/video10",
  label: "Upright Camera",
  isLoopback: true,
  canOutput: true,
};

const WEBCAM: DeviceFact = {
  path: "/dev/video0",
  label: "Integrated Camera",
  isLoopback: false,
  canOutput: true,
};

/** A machine with everything in place; each test spoils one part of it. */
function machine(overrides: Partial<OnboardingFacts> = {}): OnboardingFacts {
  return {
    devices: [WEBCAM, LOOPBACK],
    globalKeys: true,
    mic: { state: "live", error: null },
    ...overrides,
  };
}

const step = (facts: OnboardingFacts, id: string) =>
  wizardSteps(facts).find((candidate) => candidate.id === id)!;

describe("loopbackDevice", () => {
  test("picks the node that is both loopback and writable", () => {
    expect(loopbackDevice(machine())).toBe(LOOPBACK);
  });

  test("a loopback that cannot be written to is not a virtual camera", () => {
    const facts = machine({ devices: [{ ...LOOPBACK, canOutput: false }] });
    expect(loopbackDevice(facts)).toBe(null);
    expect(step(facts, "camera").state).toBe("missing");
  });

  test("a null device list finds nothing rather than guessing", () => {
    expect(loopbackDevice(machine({ devices: null }))).toBe(null);
  });
});

describe("captureDevice", () => {
  test("skips our own output and finds the webcam", () => {
    expect(captureDevice(machine())).toBe(WEBCAM);
  });

  test("a machine with only a loopback has no webcam", () => {
    expect(captureDevice(machine({ devices: [LOOPBACK] }))).toBe(null);
  });
});

describe("wizardSteps", () => {
  test("is the four steps in the order a person meets them", () => {
    const steps = wizardSteps(machine());
    expect(steps.map((entry) => entry.id)).toEqual([...STEP_ORDER]);
    for (const entry of steps) {
      expect(entry.title).toBe(STEP_COPY[entry.id].title);
      expect(entry.purpose).toBe(STEP_COPY[entry.id].purpose);
      expect(entry.blocking).toBe(STEP_COPY[entry.id].blocking);
    }
  });

  test("says what is there, by path and card name", () => {
    expect(step(machine(), "camera").stateText).toBe("found /dev/video10 (Upright Camera)");
    expect(step(machine(), "webcam").stateText).toBe("found /dev/video0 (Integrated Camera)");
  });

  test("an unnamed device is still named by its path", () => {
    const facts = machine({ devices: [{ ...LOOPBACK, label: "  " }] });
    expect(step(facts, "camera").stateText).toBe("found /dev/video10");
  });

  test("a missing camera is missing, blocking, and carries the one setup command", () => {
    const camera = step(machine({ devices: [WEBCAM] }), "camera");
    expect(camera.state).toBe("missing");
    expect(camera.blocking).toBe(true);
    expect(camera.stateText).toBe(deviceMissing().message);
    expect(camera.fix).toBe(deviceMissing().fix ?? null);
  });

  test("a backend that did not answer is unknown, not missing", () => {
    const facts = machine({ devices: null });
    expect(step(facts, "camera").state).toBe("unknown");
    expect(step(facts, "camera").fix).toBe(null);
    expect(step(facts, "webcam").state).toBe("unknown");
  });

  test("window-only keys are a hint with the input fix, never a failure", () => {
    const keys = step(machine({ globalKeys: false }), "keys");
    expect(keys.state).toBe("degraded");
    expect(keys.blocking).toBe(false);
    expect(keys.fix).toBe(inputDenied().fix ?? null);
    expect(keys.stateText).toBe(inputDenied().message);
  });

  test("a working microphone says live and offers nothing to copy", () => {
    const mic = step(machine(), "mic");
    expect(mic.state).toBe("ready");
    expect(mic.fix).toBe(null);
  });

  test("a denied microphone offers the command that has fixed it before", () => {
    const facts = machine({ mic: { state: "unavailable", error: "the microphone would not open" } });
    const mic = step(facts, "mic");
    expect(mic.state).toBe("degraded");
    expect(mic.fix).toBe(MIC_FIX);
  });

  test("a microphone that is still opening is unknown, with no command", () => {
    const facts = machine({ mic: { state: "starting", error: null } });
    const mic = step(facts, "mic");
    expect(mic.state).toBe("unknown");
    expect(mic.fix).toBe(null);
  });

  test("no mouth at all is unknown rather than a failure", () => {
    const mic = step(machine({ mic: null }), "mic");
    expect(mic.state).toBe("unknown");
    expect(mic.stateText).toContain("not been opened");
  });

  test("no webcam is degraded, never blocking: the keys still pose the face", () => {
    const webcam = step(machine({ devices: [LOOPBACK] }), "webcam");
    expect(webcam.state).toBe("degraded");
    expect(webcam.blocking).toBe(false);
    expect(webcam.fix).toBe(null);
  });
});

describe("the verdict", () => {
  test("counts only settled steps", () => {
    expect(readyCount(wizardSteps(machine()))).toBe(4);
    const gaps = machine({ devices: [LOOPBACK], globalKeys: false });
    expect(readyCount(wizardSteps(gaps))).toBe(2);
  });

  test("the first unsettled step is the camera while the camera is missing", () => {
    const facts = machine({ devices: [], globalKeys: false });
    expect(firstUnready(wizardSteps(facts))?.id).toBe("camera");
  });

  test("with the camera found, the first unsettled step is the one after it", () => {
    const facts = machine({ globalKeys: false });
    expect(firstUnready(wizardSteps(facts))?.id).toBe("keys");
  });

  test("a settled machine has no first gap", () => {
    expect(firstUnready(wizardSteps(machine()))).toBe(null);
  });

  test("the face can be broadcast with only the camera: the rest are optional", () => {
    const bare = machine({ devices: [LOOPBACK], globalKeys: false, mic: null });
    expect(canBroadcast(wizardSteps(bare))).toBe(true);
    expect(canBroadcast(wizardSteps(machine({ devices: [WEBCAM] })))).toBe(false);
    expect(canBroadcast(wizardSteps(machine({ devices: null })))).toBe(false);
  });
});

describe("cameraFailure", () => {
  test("folds the writer's refusal into the camera step alone", () => {
    const steps = wizardSteps(machine());
    const folded = cameraFailure(steps, {
      code: "device_busy",
      message: "the virtual camera is held by another program",
      detail: "timed out while opening /dev/video10",
      fix: "sudo fuser -v /dev/video*",
    });
    const camera = folded.find((entry) => entry.id === "camera")!;
    expect(camera.state).toBe("missing");
    expect(camera.stateText).toBe("the virtual camera is held by another program");
    expect(camera.fix).toBe("sudo fuser -v /dev/video*");
    // The other three are untouched, and the face is no longer broadcastable.
    expect(folded.filter((entry) => entry.id !== "camera")).toEqual(
      steps.filter((entry) => entry.id !== "camera"),
    );
    expect(canBroadcast(folded)).toBe(false);
  });

  test("a refusal with no command keeps the setup command it already had", () => {
    const steps = wizardSteps(machine({ devices: [WEBCAM] }));
    const folded = cameraFailure(steps, {
      code: "unknown",
      message: "something failed on the device side",
      detail: "no reason",
    });
    expect(folded[0].fix).toBe(deviceMissing().fix ?? null);
  });
});

describe("needsWizard", () => {
  test("a config that never saw the wizard asks for it", () => {
    expect(needsWizard({ onboarded: false })).toBe(true);
  });

  test("skipping is remembered: the second boot lands on the face", () => {
    expect(needsWizard({ onboarded: true })).toBe(false);
  });
});

describe("the module itself", () => {
  test("writes no command of its own: the fixes come from errors.ts", async () => {
    const source = await Bun.file(`${import.meta.dir}/onboarding.ts`).text();
    expect(source).not.toContain("sudo ");
    expect(source).not.toContain("systemctl ");
  });
});
