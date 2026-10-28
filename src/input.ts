import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * The controls' input.
 *
 * Inside Tauri the backend reads the keyboard, the wheel and the mouse side
 * buttons straight from the input devices, so posing the face keeps working
 * while another window has focus. The window's own events are used until then: a
 * plain browser, or a machine where the app was not granted read access to
 * `/dev/input`.
 *
 * Every key needs a mouse side button held. That is what keeps the face out of
 * the way of ordinary typing: without the modifier the keys are ignored here and
 * only reach whatever has focus, as usual.
 */

export type ControlInput =
  | { type: "keydown" | "keyup"; name: string }
  | { type: "wheel"; notches: number };

/** Shape the Rust side emits on the `input` event. */
type NativeInput =
  | { type: "key"; name: string; pressed: boolean }
  | { type: "wheel"; notches: number };

const listeners = new Set<(input: ControlInput) => void>();
const isTauri = "__TAURI_INTERNALS__" in window;

/** The mouse side buttons: held down, they let the control keys through. */
const MODIFIER_KEYS = new Set(["side", "extra"]);
/** Side buttons currently down. */
const modifiersDown = new Set<string>();
/** Keys the controls have seen pressed and not yet released. */
const forwarded = new Set<string>();

const modifiersHeld = () => modifiersDown.size > 0;

/** Whether keys arrive from the devices (true) or from the focused window. */
let globalKeys = false;
/** Detaches the window listeners once the devices take over. */
let stopWindowInput: (() => void) | null = null;

export function keysAreGlobal(): boolean {
  return globalKeys;
}

export function subscribeInput(handler: (input: ControlInput) => void): void {
  listeners.add(handler);
}

/**
 * Holds the controls behind the side buttons.
 *
 * Nothing but the modifier gets through on its own, and the modifier itself is
 * never forwarded — the controls have no use for it. A key only counts if its
 * press was let through, so releasing the side button first cannot leave a part
 * stuck mid-pose.
 */
function dispatch(input: ControlInput): void {
  if (input.type === "wheel") {
    if (modifiersHeld()) {
      emit(input);
    }
    return;
  }

  if (MODIFIER_KEYS.has(input.name)) {
    if (input.type === "keydown") {
      modifiersDown.add(input.name);
    } else {
      modifiersDown.delete(input.name);
      if (!modifiersHeld()) {
        releaseForwarded();
      }
    }
    return;
  }

  if (input.type === "keydown") {
    if (!modifiersHeld()) {
      return;
    }
    forwarded.add(input.name);
    emit(input);
    return;
  }

  if (forwarded.delete(input.name)) {
    emit(input);
  }
}

/** Releases whatever is still held when the last side button goes up. */
function releaseForwarded(): void {
  for (const name of forwarded) {
    emit({ type: "keyup", name });
  }
  forwarded.clear();
}

function emit(input: ControlInput): void {
  for (const handler of listeners) {
    handler(input);
  }
}

export async function startInput(): Promise<void> {
  if (!isTauri) {
    useWindowInput();
    return;
  }

  useWindowInput();

  // The backend announces when it can read the devices, so granting access
  // later (see scripts/setup-input-access.sh) does not need a restart.
  await listen("input-ready", () => useDeviceInput());

  try {
    if (await invoke<boolean>("input_global")) {
      useDeviceInput();
    }
  } catch {
    // Keep the window events.
  }
}

/** Fallback: only sees input while the face's window has focus. */
function useWindowInput(): void {
  if (stopWindowInput) {
    return;
  }

  // `event.key` for the space bar is a single space; the device reader calls it
  // "space", and both streams must agree on the name.
  const keyName = (event: KeyboardEvent) => (event.key === " " ? "space" : event.key.toLowerCase());

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.repeat) {
      return;
    }
    dispatch({ type: "keydown", name: keyName(event) });
  };

  const onKeyUp = (event: KeyboardEvent) => {
    dispatch({ type: "keyup", name: keyName(event) });
  };

  const onWheel = (event: WheelEvent) => {
    // Browsers scroll down for positive deltaY; notches count up.
    dispatch({ type: "wheel", notches: -Math.sign(event.deltaY) });
  };

  // Chrome reports the side buttons as buttons 3 and 4.
  const sideButton = (button: number) =>
    button === 3 ? "side" : button === 4 ? "extra" : null;

  const onMouseDown = (event: MouseEvent) => {
    const name = sideButton(event.button);
    if (name) {
      dispatch({ type: "keydown", name });
    }
  };

  const onMouseUp = (event: MouseEvent) => {
    const name = sideButton(event.button);
    if (name) {
      dispatch({ type: "keyup", name });
    }
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("wheel", onWheel, { passive: true });
  window.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mouseup", onMouseUp);

  stopWindowInput = () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("wheel", onWheel);
    window.removeEventListener("mousedown", onMouseDown);
    window.removeEventListener("mouseup", onMouseUp);
  };
}

/** Reads the devices, replacing the window listeners. */
function useDeviceInput(): void {
  if (globalKeys) {
    return;
  }

  globalKeys = true;
  stopWindowInput?.();
  stopWindowInput = null;

  void listen<NativeInput>("input", ({ payload }) => {
    if (payload.type === "wheel") {
      dispatch({ type: "wheel", notches: payload.notches });
    } else {
      dispatch({ type: payload.pressed ? "keydown" : "keyup", name: payload.name });
    }
  });
}
