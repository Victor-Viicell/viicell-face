/**
 * The synth mouth.
 *
 * In the artwork the synth line is a thin band along the bottom edge with a row
 * of short bars above it. Here it becomes a spectrum display in the style of an
 * old radio or DJ analyser: the band is the plinth and the rods grow from their
 * drawn height with the microphone. With no signal every rod sits at that drawn
 * height, so silence reproduces the artwork exactly.
 *
 * The Rust capture thread (`microphone.rs`) folds each window of input samples
 * into `POINTS` values and emits them as `mic-wave`; those values are the
 * source. One DFT probe per rod, spaced logarithmically across the voice
 * range, turns the waveform into band levels. Probes and the Hann window are
 * precomputed, so a frame costs a few thousand multiply-adds.
 *
 * To keep the display from twitching, each rod uses a fast attack and a slow
 * release, levels are smoothed across neighbouring bands, and the gain
 * reference follows the loudest band slowly instead of jumping every frame.
 * A noise floor gate keeps room noise from lighting the display at rest.
 */

import { Graphics } from "pixi.js";
import { microphoneStatus, onMicWave } from "../microphone";
import { PAINT, SYNTH } from "./art";
import { FACE } from "./palette";
import { paintToFill } from "./paint";

/** Must match `POINTS` in `src-tauri/src/microphone.rs`. */
const POINTS = 160;
/** Vertical rods across the line. */
const RODS = SYNTH.rods;
/** Travel above the resting bar height, in artboard units. */
const MAX_HEIGHT = 200;
/** Thickness of the falling peak cap, in artboard units. */
const CAP_HEIGHT = 4;
/**
 * Band range, in cycles per sample of the folded waveform. The Rust side keeps
 * one input sample in six, so at 48 kHz this spans roughly 96 Hz – 3.5 kHz.
 */
const BAND_RANGE = { low: 0.012, high: 0.44 } as const;
/** Flattens the spectrum's natural roll-off so the treble rods move too. */
const TILT = 0.5;
/** How fast the drawn level follows its band (fast in, slow out). */
const ATTACK = 0.55;
const RELEASE = 0.12;
/** Peak-cap fall speed, in fractions of full height per frame. */
const CAP_FALL = 0.028;
/** RMS that maps to a fully open display. Quiet speech should fill it. */
const FULL_SCALE_RMS = 0.010;
/** Frames older than this mean the microphone stopped. */
const STALE_AFTER_MS = 1000;

export type MouthState = "starting" | "live" | "unavailable";

export class SynthMouth {
  readonly view = new Graphics();
  state: MouthState = "starting";
  error: string | null = null;

  #waveform = new Uint8Array(POINTS);
  #window = new Float32Array(POINTS);
  #samples = new Float32Array(POINTS);
  #probes: { cos: Float32Array; sin: Float32Array; tilt: number }[] = [];
  /** Per-rod band magnitude, then reused as the smoothed target level. */
  #shaped = new Float32Array(RODS);
  #normalized = new Float32Array(RODS);
  #levels = new Float32Array(RODS);
  #peaks = new Float32Array(RODS);
  #level = 0;
  #reference = 0.01;
  #noiseFloor = 0.004;
  #lastFrameAt = 0;

  constructor() {
    this.view.label = "synth-mouth";
    this.#waveform.fill(128);

    // Hann window: stops a strong band from leaking into its neighbours.
    for (let index = 0; index < POINTS; index += 1) {
      this.#window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (POINTS - 1));
    }

    // One DFT probe per rod, precomputed with its tilt correction.
    const span = BAND_RANGE.high / BAND_RANGE.low;
    for (let rod = 0; rod < RODS; rod += 1) {
      const position = rod / (RODS - 1);
      const frequency = BAND_RANGE.low * Math.pow(span, position);
      const cos = new Float32Array(POINTS);
      const sin = new Float32Array(POINTS);
      for (let index = 0; index < POINTS; index += 1) {
        const angle = 2 * Math.PI * frequency * index;
        cos[index] = Math.cos(angle);
        sin[index] = Math.sin(angle);
      }
      this.#probes.push({
        cos,
        sin,
        tilt: Math.pow(frequency / BAND_RANGE.low, TILT),
      });
    }

    this.silence();
  }

  /** Subscribes to the microphone; on failure the mouth keeps its resting band. */
  async start(): Promise<void> {
    try {
      const status = await microphoneStatus();
      if (!status.running) {
        this.state = "unavailable";
        this.error = status.error;
        return;
      }

      await onMicWave((waveform) => {
        const count = Math.min(POINTS, waveform.length);
        for (let index = 0; index < count; index += 1) {
          this.#waveform[index] = waveform[index];
        }
        this.#lastFrameAt = performance.now();
        this.state = "live";
      });

      this.state = "live";
    } catch (error) {
      this.state = "unavailable";
      this.error = String(error);
    }
  }

  /** Pulls the latest waveform and redraws the rods. Call once per frame. */
  update(): void {
    if (this.state !== "live") {
      return;
    }

    if (performance.now() - this.#lastFrameAt > STALE_AFTER_MS) {
      this.state = "starting";
      this.silence();
      return;
    }

    const samples = this.#samples;
    const window = this.#window;
    const waveform = this.#waveform;

    let sum = 0;
    for (let index = 0; index < POINTS; index += 1) {
      const sample = (waveform[index] - 128) / 128;
      samples[index] = sample;
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / POINTS);

    // Drop to quiet levels immediately, drift back up slowly: a fan switching
    // on should not permanently lift the noise gate.
    this.#noiseFloor =
      rms < this.#noiseFloor ? rms : this.#noiseFloor + (rms - this.#noiseFloor) * 0.0008;

    const signal = Math.max(0, rms - this.#noiseFloor * 1.5);
    const gate = Math.min(1, signal / FULL_SCALE_RMS);
    this.#level += (gate - this.#level) * (gate > this.#level ? ATTACK : RELEASE);

    // Band magnitudes.
    let framePeak = 0;
    for (let rod = 0; rod < RODS; rod += 1) {
      const { cos, sin, tilt } = this.#probes[rod];
      let real = 0;
      let imaginary = 0;
      for (let index = 0; index < POINTS; index += 1) {
        const value = samples[index] * window[index];
        real += value * cos[index];
        imaginary += value * sin[index];
      }
      const magnitude = (Math.sqrt(real * real + imaginary * imaginary) * 4) / POINTS;
      const shaped = magnitude * tilt;
      this.#shaped[rod] = shaped;
      if (shaped > framePeak) {
        framePeak = shaped;
      }
    }

    // Quick up, slow down: the display fills whatever the microphone gain is,
    // without the whole row pumping on every frame.
    const referenceRate = framePeak > this.#reference ? 0.35 : 0.02;
    this.#reference += (framePeak - this.#reference) * referenceRate;
    this.#reference = Math.max(this.#reference, 0.002);

    const normalized = this.#normalized;
    for (let rod = 0; rod < RODS; rod += 1) {
      const ratio = Math.min(1, this.#shaped[rod] / this.#reference);
      // Below 1 the exponent lifts the quiet bands, so the whole row moves
      // with the voice instead of only the loudest rod.
      normalized[rod] = Math.pow(ratio, 0.65) * this.#level;
    }

    // Neighbour smoothing: a lone spike between two quiet rods reads as noise.
    for (let rod = 0; rod < RODS; rod += 1) {
      const left = normalized[rod > 0 ? rod - 1 : 0];
      const right = normalized[rod < RODS - 1 ? rod + 1 : RODS - 1];
      this.#shaped[rod] = (left + normalized[rod] * 2 + right) / 4;
    }

    for (let rod = 0; rod < RODS; rod += 1) {
      const target = this.#shaped[rod];
      const current = this.#levels[rod];
      const next = current + (target - current) * (target > current ? ATTACK : RELEASE);
      this.#levels[rod] = next;
      // Caps fall at a constant speed and land on the rod instead of fading out
      // mid-air: a gap that grows as the rod retracts reads as a broken tip.
      this.#peaks[rod] = Math.max(next, this.#peaks[rod] - CAP_FALL);
    }

    this.#draw();
  }

  /** Every rod at zero: just the resting line and its short bars. */
  silence(): void {
    this.#level = 0;
    this.#levels.fill(0);
    this.#peaks.fill(0);
    this.#draw();
  }

  #draw(): void {
    const graphics = this.view.clear();
    const left = SYNTH.left;
    const width = SYNTH.right - left;
    const base = SYNTH.baseline - SYNTH.thickness / 2;

    // The band from the artwork; rods grow from its top edge.
    graphics.rect(left, base, width, SYNTH.thickness).fill(paintToFill(PAINT.plinth));

    // Match the artwork's spacing: the rods sit on the band with a small margin
    // at both ends, and the gap is the leftover pitch.
    const inset = (width - ((RODS - 1) * SYNTH.pitch + SYNTH.rodWidth)) / 2;

    for (let rod = 0; rod < RODS; rod += 1) {
      // The artwork is at rest with every rod at `rest`; the microphone lifts
      // them from that drawn height instead of starting from nothing.
      const height = SYNTH.rest + this.#levels[rod] * MAX_HEIGHT;
      const x = left + inset + rod * SYNTH.pitch;
      // The extra unit hides the seam with the band under the transform.
      graphics.rect(x, base - height, SYNTH.rodWidth, height + 1).fill(paintToFill(PAINT.rod));
    }

    for (let rod = 0; rod < RODS; rod += 1) {
      const peak = this.#peaks[rod] * MAX_HEIGHT;
      if (peak < 1) {
        continue;
      }
      const x = left + inset + rod * SYNTH.pitch;
      graphics.rect(x, base - SYNTH.rest - peak, SYNTH.rodWidth, CAP_HEIGHT).fill(FACE.mouth.cap);
    }
  }
}
