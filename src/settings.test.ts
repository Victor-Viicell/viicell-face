import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  SettingsStore,
  mergeSettings,
  parseSettings,
  serializeSettings,
  type Settings,
  type SettingsAdapter,
} from "./settings";

/** Adapter over a string in memory: what the Rust file adapter does, without files. */
function memoryAdapter(initial: string | null = null) {
  const adapter = {
    text: initial,
    writes: [] as string[],
    fail: null as string | null,
    reader: null as string | null,
    async read() {
      if (adapter.reader !== null) {
        throw new Error(adapter.reader);
      }
      return adapter.text;
    },
    async write(text: string) {
      if (adapter.fail !== null) {
        throw new Error(adapter.fail);
      }
      adapter.writes.push(text);
      adapter.text = text;
    },
  };
  return adapter;
}

/** A store whose writes land immediately, so a test reads back at once. */
function store(adapter: SettingsAdapter | null, debounceMs = 0) {
  return new SettingsStore(adapter, { debounceMs });
}

describe("mergeSettings", () => {
  test("gives the defaults for an empty payload", () => {
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  test("keeps a full payload field for field", () => {
    const saved: Settings = {
      version: SETTINGS_VERSION,
      output: { width: 1920, height: 1080, fps: 24 },
      deviceId: "/dev/video10",
      cameraId: "/dev/video0",
      gazeOrigin: "topLeft",
      accent: "#a6e3a1",
      startMode: "track",
      window: { width: 900, height: 600, x: 40, y: -20 },
      panel: { width: 380, collapsed: true },
    };
    expect(mergeSettings(saved)).toEqual(saved);
  });

  test("ignores unknown keys instead of dropping the known ones", () => {
    const merged = mergeSettings({
      output: { width: 1600, height: 900, fps: 60, pixelFormat: "MJPG" },
      accent: "#f9e2af",
      fromTheFuture: { whatever: true },
    });
    expect(merged.output).toEqual({ width: 1600, height: 900, fps: 60 });
    expect(merged.accent).toBe("#f9e2af");
    expect("fromTheFuture" in merged).toBe(false);
    expect("pixelFormat" in merged.output).toBe(false);
  });

  test("clamps the dock width and keeps the folded flag", () => {
    // The bounds are the same ones `layout.ts` lays out with: a file from a
    // wider build comes back as a column a control still fits in.
    expect(mergeSettings({ panel: { width: 9000, collapsed: true } }).panel).toEqual({
      width: 420,
      collapsed: true,
    });
    expect(mergeSettings({ panel: { width: 40 } }).panel).toEqual({ width: 240, collapsed: false });
    expect(mergeSettings({ panel: { width: 310, collapsed: "yes" } }).panel).toEqual({
      width: 310,
      collapsed: false,
    });
  });

  test("merges an older version forward without losing values", () => {
    const merged = mergeSettings({ version: 0, output: { width: 1920, height: 1080 } });
    expect(merged.version).toBe(SETTINGS_VERSION);
    expect(merged.output.width).toBe(1920);
    expect(merged.output.height).toBe(1080);
    // A field the old file never had comes from the defaults, not from undefined.
    expect(merged.output.fps).toBe(DEFAULT_SETTINGS.output.fps);
  });

  test("falls back per field, so one bad value keeps its neighbours", () => {
    const merged = mergeSettings({
      output: { width: "1280", height: 1080, fps: Number.NaN },
      gazeOrigin: "sideways",
      accent: "blue",
      startMode: "dance",
    });
    expect(merged.output.width).toBe(DEFAULT_SETTINGS.output.width);
    expect(merged.output.height).toBe(1080);
    expect(merged.output.fps).toBe(DEFAULT_SETTINGS.output.fps);
    expect(merged.gazeOrigin).toBe("center");
    expect(merged.accent).toBe(DEFAULT_SETTINGS.accent);
    expect(merged.startMode).toBe("manual");
  });

  test("clamps sizes to even numbers the device can take", () => {
    expect(mergeSettings({ output: { width: 1281, height: 719 } }).output).toEqual({
      width: 1280,
      height: 718,
      fps: DEFAULT_SETTINGS.output.fps,
    });
    expect(mergeSettings({ output: { width: 99999, height: 1 } }).output.width).toBe(1920);
    expect(mergeSettings({ output: { width: 99999, height: 1 } }).output.height).toBe(90);
    expect(mergeSettings({ output: { fps: 0 } }).output.fps).toBe(1);
    expect(mergeSettings({ output: { fps: 500 } }).output.fps).toBe(120);
  });

  test("normalises the accent colour and the device paths", () => {
    expect(mergeSettings({ accent: "#AABBCC" }).accent).toBe("#aabbcc");
    expect(mergeSettings({ accent: "#abc" }).accent).toBe(DEFAULT_SETTINGS.accent);
    expect(mergeSettings({ deviceId: "  /dev/video2  " }).deviceId).toBe("/dev/video2");
    expect(mergeSettings({ deviceId: "   " }).deviceId).toBeNull();
    expect(mergeSettings({ cameraId: 7 }).cameraId).toBeNull();
  });

  test("keeps a partial window object together", () => {
    const merged = mergeSettings({ window: { width: 1600, x: 100.6 } });
    expect(merged.window).toEqual({
      width: 1600,
      height: DEFAULT_SETTINGS.window.height,
      x: 101,
      y: null,
    });
  });

  test("treats a non-object payload as empty", () => {
    expect(mergeSettings([1, 2, 3])).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings("nope")).toEqual(DEFAULT_SETTINGS);
  });
});

describe("parseSettings", () => {
  test("reads a stored file", () => {
    const text = serializeSettings({ ...DEFAULT_SETTINGS, accent: "#cba6f7" });
    expect(parseSettings(text).accent).toBe("#cba6f7");
  });

  test("survives a missing file", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("   ")).toEqual(DEFAULT_SETTINGS);
  });

  test("survives truncated JSON", () => {
    expect(parseSettings('{"output": {"width": 1920')).toEqual(DEFAULT_SETTINGS);
  });

  test("round-trips through serialize", () => {
    const settings = { ...DEFAULT_SETTINGS, startMode: "track" as const };
    expect(parseSettings(serializeSettings(settings))).toEqual(settings);
  });
});

describe("SettingsStore", () => {
  test("starts at the defaults before it has loaded anything", () => {
    expect(store(memoryAdapter()).current).toEqual(DEFAULT_SETTINGS);
  });

  test("a reload restores every field", async () => {
    const adapter = memoryAdapter();
    const first = store(adapter);
    await first.load();

    first.set({
      output: { width: 1920, height: 1080, fps: 15 },
      deviceId: "/dev/video42",
      cameraId: "/dev/video1",
      gazeOrigin: "bottomRight",
      accent: "#f38ba8",
      startMode: "track",
      window: { width: 1024, height: 700, x: -12, y: 34 },
    });
    await first.flush();

    const second = store(adapter);
    const restored = await second.load();
    expect(restored).toEqual(first.current);
    expect(restored.output.width).toBe(1920);
    expect(restored.gazeOrigin).toBe("bottomRight");
    expect(restored.startMode).toBe("track");
    expect(restored.window).toEqual({ width: 1024, height: 700, x: -12, y: 34 });
  });

  test("a folded dock stays folded, and a partial patch keeps the width", async () => {
    const adapter = memoryAdapter();
    const first = store(adapter);
    await first.load();
    first.set({ panel: { width: 380 } });
    // The fold is one flag; it must not reset the width it was last left at.
    first.set({ panel: { collapsed: true } });
    await first.flush();
    expect(first.current.panel).toEqual({ width: 380, collapsed: true });

    const second = store(adapter);
    expect((await second.load()).panel).toEqual({ width: 380, collapsed: true });
  });

  test("an old file keeps its values and gains the new fields", async () => {
    const adapter = memoryAdapter('{"version": 0, "output": {"width": 1920, "height": 1080}}');
    const loaded = await store(adapter).load();
    expect(loaded.output.width).toBe(1920);
    expect(loaded.accent).toBe(DEFAULT_SETTINGS.accent);
    // Reading must not rewrite what it cannot understand; the file still holds
    // the old shape until something actually changes.
    expect(adapter.writes).toHaveLength(0);
  });

  test("a corrupt file loads as defaults and is left on disk", async () => {
    const adapter = memoryAdapter("{not json");
    const loaded = await store(adapter).load();
    expect(loaded).toEqual(DEFAULT_SETTINGS);
    expect(adapter.text).toBe("{not json");
    expect(adapter.writes).toHaveLength(0);
  });

  test("a failing read is recorded, not thrown", async () => {
    const adapter = memoryAdapter();
    adapter.reader = "settings file is locked";
    const settings = store(adapter);
    expect(await settings.load()).toEqual(DEFAULT_SETTINGS);
    expect(settings.error).toBe("settings file is locked");
  });

  test("coalesces a burst of changes into one write", async () => {
    const adapter = memoryAdapter();
    const settings = store(adapter, 20);
    await settings.load();

    settings.set({ output: { width: 1280 } });
    settings.set({ output: { width: 1600 } });
    settings.set({ output: { width: 1920 } });
    expect(adapter.writes).toHaveLength(0);

    await settings.flush();
    expect(adapter.writes).toHaveLength(1);
    expect(JSON.parse(adapter.writes[0]!).output.width).toBe(1920);
  });

  test("flush with nothing pending writes nothing", async () => {
    const adapter = memoryAdapter();
    const settings = store(adapter, 20);
    await settings.load();
    await settings.flush();
    expect(adapter.writes).toHaveLength(0);
  });

  test("a patch that changes nothing neither writes nor notifies", async () => {
    const adapter = memoryAdapter();
    const settings = store(adapter);
    await settings.load();

    let calls = 0;
    settings.subscribe(() => {
      calls += 1;
    });
    settings.set({ accent: DEFAULT_SETTINGS.accent });
    settings.set({ accent: "#AABBCC" });
    settings.set({ accent: "#aabbcc" });
    await settings.flush();

    expect(calls).toBe(1);
    expect(adapter.writes).toHaveLength(1);
  });

  test("set() returns the clamped values for the caller to use at once", () => {
    const settings = store(memoryAdapter());
    const next = settings.set({ output: { width: 1281, fps: 999 } });
    expect(next.output.width).toBe(1280);
    expect(next.output.fps).toBe(120);
    expect(settings.value("output").fps).toBe(120);
  });

  test("a partial patch keeps the sibling fields", async () => {
    const settings = store(memoryAdapter());
    settings.set({ output: { width: 1920, height: 1080 } });
    settings.set({ output: { fps: 24 } });
    expect(settings.value("output")).toEqual({ width: 1920, height: 1080, fps: 24 });
  });

  test("a failed write is reported and changes nothing in memory", async () => {
    const adapter = memoryAdapter();
    const settings = store(adapter);
    await settings.load();
    adapter.fail = "disk is full";

    settings.set({ accent: "#a6e3a1" });
    await settings.flush();

    expect(settings.value("accent")).toBe("#a6e3a1");
    expect(settings.error).toBe("disk is full");
    expect(adapter.writes).toHaveLength(0);
  });

  test("without an adapter it stays in memory and never pretends to save", async () => {
    const settings = store(null);
    expect(await settings.load()).toEqual(DEFAULT_SETTINGS);
    settings.set({ accent: "#94e2d5" });
    expect(settings.value("accent")).toBe("#94e2d5");
    expect(await settings.save()).toBe(false);
    expect(settings.error).toBeNull();
  });

  test("dispose() drops the pending write", async () => {
    const adapter = memoryAdapter();
    const settings = store(adapter, 20);
    await settings.load();
    settings.set({ accent: "#f5c2e7" });
    settings.dispose();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(adapter.writes).toHaveLength(0);
  });
});
