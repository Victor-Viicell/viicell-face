/**
 * The first-run wizard's decisions, made without a DOM.
 *
 * A fresh install has four things to line up before the face is worth looking
 * at: a loopback device to broadcast into, permission to read the keys from any
 * window, a microphone for the synth line, and a webcam for the tracking mode.
 * Which step is settled, what its line says, which command fixes it, and whether
 * the face can be broadcast at all follow from one {@link OnboardingFacts}
 * value — so `bun test` pins the whole thing with no window and no device.
 *
 * No command is written here: they come from `./errors`, the one place a failure
 * becomes words and a fix (`deviceMissing`, `inputDenied`, `MIC_FIX`). The DOM
 * half is `./onboarding_panel`; this module imports nothing that touches a node.
 */

import { type AppError, classify, deviceMissing, inputDenied, MIC_FIX } from "./errors";
import type { Settings } from "./settings";

/** The four steps, in the order a person meets them. */
export type StepId = "camera" | "keys" | "mic" | "webcam";

/**
 * How one step stands.
 *
 * `degraded` is the interesting one: the face still works, something is less
 * good than it could be (keys only in the window, no mic, no webcam), and the
 * step says so without pretending it is a failure.
 */
export type StepState = "ready" | "degraded" | "missing" | "unknown";

/** One entry of `list_video_devices`, as the wizard needs it. */
export interface DeviceFact {
  path: string;
  label: string;
  /** A v4l2loopback-style node: something we can write into. */
  isLoopback: boolean;
  canOutput: boolean;
}

/** The microphone's state, as `SynthMouth` reports it. */
export interface MicFact {
  state: string;
  error: string | null;
}

/** Everything the wizard can see about the machine right now. */
export interface OnboardingFacts {
  /**
   * `list_video_devices()`, or `null` when the backend would not answer.
   *
   * `null` and `[]` are different answers on purpose: no devices at all is "none
   * plugged in", a refused command is "I could not look" — and only the second
   * one is fixed by pressing the same button again.
   */
  devices: readonly DeviceFact[] | null;
  /** `keysAreGlobal()`: the devices are readable, not just the focused window. */
  globalKeys: boolean;
  /** The microphone, or `null` before the mouth has been created. */
  mic: MicFact | null;
}

/** One step, ready to paint: what it is, how it stands, and what fixes it. */
export interface WizardStep {
  id: StepId;
  title: string;
  /** One line: what this step is for, in the product's own voice. */
  purpose: string;
  state: StepState;
  /** One line: how it stands right now. */
  stateText: string;
  /** The command that fixes it, copyable. `null` when none is known. */
  fix: string | null;
  /** Without this the face cannot be broadcast at all; the rest are optional. */
  blocking: boolean;
}

/** The step order, shared by the decisions and by the rows the panel builds. */
export const STEP_ORDER: readonly StepId[] = ["camera", "keys", "mic", "webcam"];

/** The fixed half of each step: the words that do not depend on the machine. */
export const STEP_COPY: Readonly<Record<StepId, Omit<WizardStep, "state" | "stateText" | "fix">>> = {
  camera: {
    id: "camera",
    title: "virtual camera",
    purpose: "the device Zoom, Meet and OBS pick up as a webcam",
    blocking: true,
  },
  keys: {
    id: "keys",
    title: "keys from any window",
    purpose: "pose the face while another app has focus",
    blocking: false,
  },
  mic: {
    id: "mic",
    title: "microphone",
    purpose: "the spectrum line across the face, driven by your voice",
    blocking: false,
  },
  webcam: {
    id: "webcam",
    title: "webcam for facial track",
    purpose: "the landmarker reads your real face; manual mode does not need it",
    blocking: false,
  },
};

/** The first device that can be written to — the one we broadcast into. */
export function loopbackDevice(facts: OnboardingFacts): DeviceFact | null {
  return facts.devices?.find((device) => device.isLoopback && device.canOutput) ?? null;
}

/**
 * The first node that is not our own output: a webcam.
 *
 * `face_camera::find_device` also honours `VIICELL_FACE_DEVICE`, which the
 * webview cannot read, so this is "a camera exists", not "the pinned one works";
 * a bad pin shows up as `camera_missing` in track mode and the panel says it.
 */
export function captureDevice(facts: OnboardingFacts): DeviceFact | null {
  return facts.devices?.find((device) => !device.isLoopback) ?? null;
}

/** `found /dev/video10 (Upright Camera)`, or just the path when it is unnamed. */
function deviceFound(device: DeviceFact): string {
  const name = device.label.trim();
  return name === "" ? `found ${device.path}` : `found ${device.path} (${name})`;
}

function cameraStep(facts: OnboardingFacts): WizardStep {
  const copy = STEP_COPY.camera;
  if (facts.devices === null) {
    return { ...copy, state: "unknown", stateText: "the backend did not answer", fix: null };
  }
  const device = loopbackDevice(facts);
  if (device !== null) {
    return { ...copy, state: "ready", stateText: deviceFound(device), fix: null };
  }
  const problem = deviceMissing();
  return { ...copy, state: "missing", stateText: problem.message, fix: problem.fix ?? null };
}

function keysStep(facts: OnboardingFacts): WizardStep {
  const copy = STEP_COPY.keys;
  if (facts.globalKeys) {
    return { ...copy, state: "ready", stateText: "the input devices are readable", fix: null };
  }
  const problem = inputDenied();
  return { ...copy, state: "degraded", stateText: problem.message, fix: problem.fix ?? null };
}

function micStep(facts: OnboardingFacts): WizardStep {
  const copy = STEP_COPY.mic;
  const mic = facts.mic;
  if (mic === null) {
    return { ...copy, state: "unknown", stateText: "the microphone has not been opened", fix: null };
  }
  if (mic.state === "live") {
    return { ...copy, state: "ready", stateText: "live", fix: null };
  }
  // A real failure names its own fix; a mic that is merely still opening gets
  // no command, because there is nothing wrong with it yet.
  if (mic.error !== null) {
    const problem = classify(mic.error, "mic");
    return { ...copy, state: "degraded", stateText: problem.message, fix: problem.fix ?? MIC_FIX };
  }
  return { ...copy, state: "unknown", stateText: "still opening", fix: null };
}

function webcamStep(facts: OnboardingFacts): WizardStep {
  const copy = STEP_COPY.webcam;
  if (facts.devices === null) {
    return { ...copy, state: "unknown", stateText: "the backend did not answer", fix: null };
  }
  const device = captureDevice(facts);
  if (device !== null) {
    return { ...copy, state: "ready", stateText: deviceFound(device), fix: null };
  }
  return {
    ...copy,
    state: "degraded",
    stateText: "no webcam — the keys still pose the face",
    fix: null,
  };
}

/** All four steps, in order, from one look at the machine. */
export function wizardSteps(facts: OnboardingFacts): WizardStep[] {
  return [cameraStep(facts), keysStep(facts), micStep(facts), webcamStep(facts)];
}

/** How many steps are settled; the wizard's title counts them. */
export function readyCount(steps: readonly WizardStep[]): number {
  return steps.filter((step) => step.state === "ready").length;
}

/**
 * The first step that is not settled — the one worth talking about first.
 *
 * The order puts the virtual camera in front, so when it is missing this is the
 * camera and nothing else matters yet.
 */
export function firstUnready(steps: readonly WizardStep[]): WizardStep | null {
  return steps.find((step) => step.state !== "ready") ?? null;
}

/** Whether the face can be broadcast: no blocking step is missing or unread. */
export function canBroadcast(steps: readonly WizardStep[]): boolean {
  return steps.every((step) => !step.blocking || step.state === "ready");
}

/**
 * The writer's refusal, folded into the camera step.
 *
 * The probe only sees devices, so a loopback that exists but will not open
 * (`busy`, `permission denied`) reads as ready there. Asking the writer is the
 * only honest answer, and this is what it says when the answer is no.
 */
export function cameraFailure(
  steps: readonly WizardStep[],
  error: AppError,
): WizardStep[] {
  return steps.map((step) =>
    step.id === "camera"
      ? { ...step, state: "missing", stateText: error.message, fix: error.fix ?? step.fix }
      : step,
  );
}

/** Whether the wizard should open by itself: a config that never saw it. */
export function needsWizard(settings: Pick<Settings, "onboarded">): boolean {
  return !settings.onboarded;
}
