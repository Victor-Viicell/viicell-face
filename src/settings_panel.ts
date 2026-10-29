/**
 * The settings panel: the dock's controls for the things the app remembers.
 *
 * Every control writes through the store and paints back from the store, so a
 * restart is the only thing that can make the panel disagree with what the app
 * is doing. A change of size or rate is not just a number: the canvas buffer,
 * the rig scale, the ticker rate and the v4l2 format all have to move together,
 * so the panel hands that to `applyOutput` (in `./stream`) and keeps the
 * controls disabled until it settles.
 *
 * The pieces with a rule — which sizes are offered, how a size is read, what the
 * controls should read — live in `./settings_view` and are tested there. This
 * file is listeners and the paint, and it asks `./shell` for every node.
 */

import { type GazeAnchor } from "./anchor";
import type { Settings, SettingsPatch, SettingsStore } from "./settings";
import { fpsChoices, originChoices, outputChoices, panelView, parseSize } from "./settings_view";
import * as shell from "./shell";

/** The rest of the app, as the panel needs it. */
export interface PanelActions {
  /**
   * Makes the stream match the store: canvas size, rig scale, tick rate, then a
   * fresh `start_camera`. Rejects when the device refused the new format.
   */
  reconnect: () => Promise<void>;
  /**
   * The same origin path the `0` and `1`–`5` keys use (`controls.ts`), so the
   * button and the key cannot end up in different places.
   */
  setOrigin: (anchor: GazeAnchor) => void;
}

/**
 * Wires the panel to the store, once, at boot.
 *
 * It also takes the fold toggle over from `main.ts`: folding is one stored flag
 * and this module is where every stored-flag handler lives.
 */
export function installSettingsPanel(settings: SettingsStore, actions: PanelActions): void {
  const originButtons = buildOriginButtons();
  paintChoices(settings.current);
  paint(settings.current);

  shell.settingSize.addEventListener("change", () => {
    const size = parseSize(shell.settingSize.value);
    if (size === null) {
      // Something edited the option list by hand; show what is stored instead.
      paint(settings.current);
      return;
    }
    void restart({ output: size });
  });

  shell.settingFps.addEventListener("change", () => {
    const fps = Number(shell.settingFps.value);
    if (!Number.isFinite(fps) || fps <= 0) {
      paint(settings.current);
      return;
    }
    void restart({ output: { fps } });
  });

  shell.settingStartTrack.addEventListener("change", () => {
    settings.set({ startMode: shell.settingStartTrack.checked ? "track" : "manual" });
  });

  for (const button of originButtons) {
    button.addEventListener("click", () => {
      actions.setOrigin(button.dataset.anchor as GazeAnchor);
    });
  }

  shell.panelToggle.addEventListener("click", () => {
    settings.set({ panel: { collapsed: !settings.value("panel").collapsed } });
    shell.relayout();
  });

  // The paint follows the store, never the click: a key, the panel and a loaded
  // file all land here.
  settings.subscribe((next) => paint(next));

  /** Writes, then makes the stream match. The controls stay dead until it settles. */
  async function restart(patch: SettingsPatch): Promise<void> {
    settings.set(patch);
    shell.setSettingsBusy(true);
    try {
      await actions.reconnect();
    } catch (error) {
      // `applyOutput` reports the device's own words through the error panel;
      // this is only here so a failure cannot leave the controls disabled.
      shell.showError(error);
    } finally {
      shell.setSettingsBusy(false);
    }
  }

  function paintChoices(current: Settings): void {
    const sizes = outputChoices(current.output.width, current.output.height);
    shell.settingSize.replaceChildren(
      ...sizes.map((size) => new Option(size.label, size.label)),
    );
    shell.settingFps.replaceChildren(
      ...fpsChoices(current.output.fps).map((fps) => new Option(String(fps), String(fps))),
    );
  }

  function paint(current: Settings): void {
    const view = panelView(current);
    if (shell.settingSize.value !== view.size) shell.settingSize.value = view.size;
    if (shell.settingFps.value !== view.fps) shell.settingFps.value = view.fps;
    if (shell.settingStartTrack.checked !== view.startTrack) {
      shell.settingStartTrack.checked = view.startTrack;
    }
    for (const button of originButtons) {
      const active = button.dataset.anchor === view.origin;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }
  }
}

/** One button per anchor, built from the shared list so a label cannot drift. */
function buildOriginButtons(): HTMLButtonElement[] {
  const buttons = originChoices().map(({ anchor, label }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "origin-button";
    button.dataset.anchor = anchor;
    button.textContent = label;
    button.title = `eyes look from the ${label}`;
    button.setAttribute("aria-pressed", "false");
    return button;
  });
  shell.settingOrigin.replaceChildren(...buttons);
  return buttons;
}
