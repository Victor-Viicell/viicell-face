/**
 * The persisted settings store.
 *
 * One plain object holds everything the app remembers across restarts; nothing
 * here touches the DOM, Tauri or the filesystem, so the whole merge/clamp/debounce
 * path is covered by `bun test` with no window and no app.
 *
 * The file itself is owned by the Rust side (`read_settings` / `write_settings`
 * in `src-tauri/src/lib.rs`, `<app config dir>/settings.json`); the frontend only
 * sees an {@link SettingsAdapter}. A session without Tauri — the browser preview —
 * passes `null` and keeps the defaults in memory.
 *
 * Reading is deliberately forgiving: a missing file, corrupt JSON, a field of the
 * wrong type or a key written by a newer build must never reset the rest of the
 * file. Unknown keys are dropped, known ones are merged field by field, and only
 * values that cannot be made sense of fall back to their default.
 */

import { GAZE_ANCHORS, type GazeAnchor } from "./anchor";
import type { FaceMode } from "./mode";

/** Bumped when a field changes meaning, not when one is added. */
export const SETTINGS_VERSION = 1;

/** The size and rate the canvas is broadcast at. */
export interface OutputSettings {
  width: number;
  height: number;
  fps: number;
}

/** Where the window was; `null` for a position is "let the compositor place it". */
export interface WindowSettings {
  width: number;
  height: number;
  x: number | null;
  y: number | null;
}

/** Everything the app remembers. */
export interface Settings {
  version: number;
  output: OutputSettings;
  /** Loopback device path, or `null` for the first one the backend finds. */
  deviceId: string | null;
  /** Webcam path for the tracking mode, or `null` for the backend's pick. */
  cameraId: string | null;
  gazeOrigin: GazeAnchor;
  /** Pupil colour, `#rrggbb`. */
  accent: string;
  startMode: FaceMode;
  window: WindowSettings;
}

/**
 * Where the backend keeps and hands out the settings file.
 *
 * `read()` resolves to `null` when nothing has been saved yet, and `write()`
 * rejects when the file could not be saved — the store records that instead of
 * throwing into the frame path.
 */
export interface SettingsAdapter {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

/**
 * Bounds every stored number is clamped into.
 *
 * YUYV 4:2:2 needs pixel pairs, so output sizes are even; the upper bounds are
 * what the recommended `v4l2loopback` setup accepts, but a larger value is
 * clamped rather than rejected, because the device reports its own maximum and
 * the stream start is what has to be retried.
 */
export const LIMITS = {
  output: { minWidth: 160, maxWidth: 1920, minHeight: 90, maxHeight: 1080, minFps: 1, maxFps: 120 },
  window: { minWidth: 320, maxWidth: 7680, minHeight: 240, maxHeight: 4320 },
} as const;

/** The values a fresh install boots with — also the shape every load merges onto. */
export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  output: { width: 1280, height: 720, fps: 30 },
  deviceId: null,
  cameraId: null,
  gazeOrigin: "center",
  accent: "#89b4fa",
  startMode: "manual",
  window: { width: 1280, height: 800, x: null, y: null },
};

const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A finite integer inside `[min, max]`, or `fallback`. */
function integer(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** A finite integer that is also even — a frame size YUYV can carry. */
function even(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const clamped = Math.min(max, Math.max(min, Math.round(value)));
  return clamped - (clamped % 2);
}

/** A non-empty device path, or `null` for "pick one for me". */
function deviceId(value: unknown, fallback: string | null): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** An optional window coordinate: a number, `null`, or `null` when unusable. */
function coordinate(value: unknown, fallback: number | null): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.round(value);
}

/**
 * Deep-merges a parsed payload onto `base`, ignoring anything it does not know.
 *
 * Every field is validated on its own: one bad value never takes its neighbours
 * down with it, and keys from a newer or older build are simply not copied.
 */
export function mergeSettings(raw: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const source = isRecord(raw) ? raw : {};
  const output = isRecord(source.output) ? source.output : {};
  const window = isRecord(source.window) ? source.window : {};

  return {
    version: SETTINGS_VERSION,
    output: {
      width: even(output.width, LIMITS.output.minWidth, LIMITS.output.maxWidth, base.output.width),
      height: even(output.height, LIMITS.output.minHeight, LIMITS.output.maxHeight, base.output.height),
      fps: integer(output.fps, LIMITS.output.minFps, LIMITS.output.maxFps, base.output.fps),
    },
    deviceId: deviceId(source.deviceId, base.deviceId),
    cameraId: deviceId(source.cameraId, base.cameraId),
    gazeOrigin:
      typeof source.gazeOrigin === "string" &&
      (GAZE_ANCHORS as readonly string[]).includes(source.gazeOrigin)
        ? (source.gazeOrigin as GazeAnchor)
        : base.gazeOrigin,
    accent:
      typeof source.accent === "string" && HEX_COLOUR.test(source.accent)
        ? source.accent.toLowerCase()
        : base.accent,
    startMode:
      source.startMode === "manual" || source.startMode === "track"
        ? source.startMode
        : base.startMode,
    window: {
      width: integer(window.width, LIMITS.window.minWidth, LIMITS.window.maxWidth, base.window.width),
      height: integer(
        window.height,
        LIMITS.window.minHeight,
        LIMITS.window.maxHeight,
        base.window.height,
      ),
      x: coordinate(window.x, base.window.x),
      y: coordinate(window.y, base.window.y),
    },
  };
}

/** Parses a stored file; anything unreadable yields `base` untouched. */
export function parseSettings(text: string | null, base: Settings = DEFAULT_SETTINGS): Settings {
  if (text === null || text.trim() === "") {
    return mergeSettings(base, base);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return mergeSettings(base, base);
  }
  return mergeSettings(raw, base);
}

/** The exact bytes written to disk: stable order, two spaces, trailing newline. */
export function serializeSettings(settings: Settings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** A patch: top-level fields, with the two objects allowed to arrive partially. */
export type SettingsPatch = Partial<Omit<Settings, "output" | "window">> & {
  output?: Partial<OutputSettings>;
  window?: Partial<WindowSettings>;
};

export interface SettingsOptions {
  /** What a missing or unreadable file falls back to. */
  base?: Settings;
  /** Coalescing window for `set()`; `0` still defers to the next task. */
  debounceMs?: number;
}

/**
 * The store: one cached object, one debounced write.
 *
 * `current` is a plain object on purpose — the frame pump reads `output.fps` off
 * it directly, and that has to stay a field access. Treat it as read-only; go
 * through `set()` so the change reaches the file and the listeners.
 */
export class SettingsStore {
  readonly #adapter: SettingsAdapter | null;
  readonly #base: Settings;
  readonly #debounceMs: number;
  readonly #listeners = new Set<(settings: Settings) => void>();
  #settings: Settings;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #error: string | null = null;

  constructor(adapter: SettingsAdapter | null, options: SettingsOptions = {}) {
    this.#adapter = adapter;
    this.#base = options.base ?? DEFAULT_SETTINGS;
    this.#debounceMs = options.debounceMs ?? 250;
    this.#settings = mergeSettings(this.#base, this.#base);
  }

  /** The live settings object. Read it; never write to it. */
  get current(): Readonly<Settings> {
    return this.#settings;
  }

  /** Why the last load or save failed, if it did; `null` once one succeeds. */
  get error(): string | null {
    return this.#error;
  }

  /** One field, typed — the frame path's accessor. */
  value<K extends keyof Settings>(key: K): Settings[K] {
    return this.#settings[key];
  }

  /**
   * Reads the stored file into the store.
   *
   * Never throws: a missing file, corrupt JSON or a failing adapter all end with
   * the defaults in place. Listeners are told, because the values they cached at
   * construction are now stale.
   */
  async load(): Promise<Settings> {
    let text: string | null = null;
    if (this.#adapter !== null) {
      try {
        text = await this.#adapter.read();
        this.#error = null;
      } catch (error) {
        this.#error = describe(error);
      }
    }
    this.#settings = parseSettings(text, this.#base);
    this.#notify();
    return this.#settings;
  }

  /**
   * Merges a patch in, clamps it, tells the listeners and schedules the write.
   *
   * Returns the new object (unchanged, and with no write, when the patch changes
   * nothing) so a caller can use the clamped values straight away.
   */
  set(patch: SettingsPatch): Settings {
    const merged = {
      ...this.#settings,
      ...patch,
      output: { ...this.#settings.output, ...(patch.output ?? {}) },
      window: { ...this.#settings.window, ...(patch.window ?? {}) },
    };
    const next = mergeSettings(merged, this.#base);

    if (serializeSettings(next) === serializeSettings(this.#settings)) {
      return this.#settings;
    }

    this.#settings = next;
    this.#notify();
    this.#schedule();
    return next;
  }

  /** Writes now, cancelling a pending debounced write. Resolves to whether it landed. */
  async save(): Promise<boolean> {
    this.#cancel();
    if (this.#adapter === null) {
      return false;
    }
    try {
      await this.#adapter.write(serializeSettings(this.#settings));
      this.#error = null;
      return true;
    } catch (error) {
      this.#error = describe(error);
      return false;
    }
  }

  /** Waits for a debounced write to land; a no-op when nothing is pending. */
  async flush(): Promise<void> {
    if (this.#timer === null) {
      return;
    }
    await this.save();
  }

  /** Listening for changes; returns the unsubscribe. */
  subscribe(listener: (settings: Settings) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Drops the pending write and every listener. */
  dispose(): void {
    this.#cancel();
    this.#listeners.clear();
  }

  #schedule(): void {
    // One timer per burst: a slider dragged across twenty values writes once.
    if (this.#timer !== null) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.save();
    }, this.#debounceMs);
  }

  #cancel(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      listener(this.#settings);
    }
  }
}

/** A saved error message that is short enough to show in a panel. */
function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  const text = String(error).trim();
  return text === "" ? "settings could not be saved" : text;
}
