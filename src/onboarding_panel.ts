/**
 * The first-run wizard: four steps over the stage, one row each.
 *
 * Every decision — which step is settled, what its line says, which command
 * fixes it, whether the face can be broadcast — is in `./onboarding`, which
 * `bun test` pins with no window. This file is the wiring: one probe, one paint,
 * three buttons, and the `onboarded` flag that stops it opening again.
 *
 * No command is written here: a row's fix comes from the step, and the step got
 * it from `./errors`.
 */

import { cameraStatus, listVideoDevices } from "./camera";
import { classify, type AppError } from "./errors";
import { keysAreGlobal } from "./input";
import {
  STEP_COPY,
  STEP_ORDER,
  cameraFailure,
  canBroadcast,
  firstUnready,
  needsWizard,
  readyCount,
  type MicFact,
  type OnboardingFacts,
  type WizardStep,
  wizardSteps,
} from "./onboarding";
import type { SettingsStore } from "./settings";
import * as shell from "./shell";
import { connect } from "./stream";

/** Where the microphone's state comes from; `main.ts` owns the mouth. */
export type MicProbe = () => MicFact | null;

/** One step's nodes, built once and repainted as the machine changes. */
interface Row {
  root: HTMLElement;
  state: HTMLElement;
  copy: HTMLButtonElement;
}

/**
 * Asks the backend and the input layer how the machine stands.
 *
 * Devices are the only thing that can refuse to answer; a refused command is
 * reported as `null` and painted as "the backend did not answer", which is the
 * one state a second press of `Check again` can honestly fix.
 */
async function probe(mic: MicProbe): Promise<OnboardingFacts> {
  let devices: OnboardingFacts["devices"] = null;
  try {
    devices = await listVideoDevices();
  } catch {
    devices = null;
  }
  return { devices, globalKeys: keysAreGlobal(), mic: mic() };
}

/**
 * Wires the wizard to the store, once, at boot.
 *
 * It opens by itself on a config that has never been through it and never again
 * after that: `onboarded` is what makes the second boot land on the face.
 */
export function installWizard(settings: SettingsStore, mic: MicProbe): void {
  const rows = buildRows();
  let open = false;

  shell.wizardRetry.addEventListener("click", () => void retry());
  shell.wizardClose.addEventListener("click", () => close());
  shell.settingSetup.addEventListener("click", () => show());

  function show(): void {
    open = true;
    shell.wizardPanel.hidden = false;
    // The step list is about the machine, so the panel's quieter copy of the
    // same failure stays out of the way while it is up.
    shell.setWizardOpen(true);
    pending();
    void look();
  }

  function close(): void {
    open = false;
    shell.wizardPanel.hidden = true;
    shell.setWizardOpen(false);
    // Skipping sticks. Through the store, so it also reaches the file.
    settings.set({ onboarded: true });
  }

  /** One probe, then the paint. */
  async function look(): Promise<void> {
    const steps = wizardSteps(await probe(mic));
    if (open) paint(steps);
  }

  /**
   * Re-checks the machine; when the camera is there, asks the writer to start.
   *
   * The probe only sees devices, so a loopback that exists but will not open
   * (`busy`, `permission denied`) still reads as ready. `cameraStatus` is the
   * writer's own answer, and a refusal is folded back into the camera step
   * instead of reaching the panel, which is quiet while the wizard is up.
   */
  async function retry(): Promise<void> {
    let steps = wizardSteps(await probe(mic));
    if (canBroadcast(steps)) {
      steps = await started(steps);
    }
    if (open) paint(steps);
  }

  async function started(steps: WizardStep[]): Promise<WizardStep[]> {
    let failure: AppError | null = null;
    try {
      await connect();
      const status = await cameraStatus();
      if (status.error !== null) {
        failure = classify(status.error, "camera");
      }
    } catch (error) {
      failure = classify(error, "camera");
    }
    return failure === null ? steps : cameraFailure(steps, failure);
  }

  /** The rows before the first probe has answered: there is nothing to claim. */
  function pending(): void {
    for (const row of rows) {
      row.root.dataset.state = "unknown";
      row.root.classList.remove("next");
      row.state.textContent = "checking…";
      row.copy.hidden = true;
    }
    shell.wizardCount.textContent = "";
    shell.wizardClose.textContent = "Skip";
  }

  function paint(steps: readonly WizardStep[]): void {
    const first = firstUnready(steps);
    steps.forEach((step, index) => {
      const row = rows[index];
      row.root.dataset.state = step.state;
      row.root.classList.toggle("next", step === first);
      row.state.textContent = step.stateText;
      row.copy.hidden = step.fix === null;
      // The row's click handler copies whatever the last paint left here, so a
      // recovered step can never hand over the command it used to need.
      row.copy.dataset.fix = step.fix ?? "";
      row.copy.title = step.fix === null ? "" : step.fix;
    });
    shell.wizardCount.textContent = `${readyCount(steps)}/${steps.length}`;
    shell.wizardClose.textContent = canBroadcast(steps) ? "Done" : "Skip";
  }

  if (needsWizard(settings.current)) {
    show();
  }
}

/** One row per step, titled from the shared copy so a label cannot drift. */
function buildRows(): Row[] {
  const rows = STEP_ORDER.map((id) => {
    const copy = STEP_COPY[id];

    const root = document.createElement("li");
    root.className = "wizard-step";
    root.dataset.step = id;

    const head = document.createElement("div");
    head.className = "wizard-step-head";
    const title = document.createElement("span");
    title.className = "wizard-step-title";
    title.textContent = copy.title;
    const state = document.createElement("span");
    state.className = "wizard-step-state";
    head.append(title, state);

    const why = document.createElement("p");
    why.className = "wizard-step-why";
    why.textContent = copy.purpose;

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "wizard-copy";
    copyButton.textContent = "Copy";
    copyButton.hidden = true;
    copyButton.addEventListener("click", () => {
      void shell.copyText(copyButton.dataset.fix ?? "", copyButton);
    });

    root.append(head, why, copyButton);
    return { root, state, copy: copyButton };
  });
  shell.wizardList.replaceChildren(...rows.map((row) => row.root));
  return rows;
}
