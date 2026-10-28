/**
 * The face's backdrop.
 *
 * One full-artboard quad drawn by a small fragment shader. The shader carries
 * the part of the look that a flat fill cannot: a radial lift from Mantle at
 * the centre to Crust at the corners, two very slow aurora glows in Sapphire
 * and Mauve, and a one-step dither that stops the shallow gradient from banding
 * once the frame is converted to YUYV for the virtual camera.
 *
 * The program is WebGL only (`Filter.from` with a GL program). `main.ts` asks
 * the application for the WebGL renderer, so that is the path it always takes.
 */

import { Filter, Graphics, Rectangle, defaultFilterVert } from "pixi.js";
import { ARTBOARD } from "./art";
import { FACE, rgb } from "./palette";

const FRAGMENT = /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform float uTime;
uniform vec3 uInner;
uniform vec3 uOuter;
uniform vec3 uCool;
uniform vec3 uWarm;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  // Measure in 16:9 space so the vignette and the halos stay round instead of
  // stretching with the canvas.
  vec2 p = (vTextureCoord - 0.5) * vec2(16.0 / 9.0, 1.0) * 2.0;

  float edge = smoothstep(0.05, 1.15, length(p));
  vec3 color = mix(uInner, uOuter, edge);

  // Two soft lights drifting against each other: cool above the left eye,
  // warm below the right. Amplitudes are small so the face stays the subject.
  vec2 cool = p - vec2(-0.72 + 0.05 * sin(uTime * 0.09), -0.52 + 0.04 * cos(uTime * 0.07));
  vec2 warm = p - vec2(0.78 + 0.04 * cos(uTime * 0.06), 0.58 + 0.05 * sin(uTime * 0.08));
  color += uCool * exp(-dot(cool, cool) * 5.0) * 0.075;
  color += uWarm * exp(-dot(warm, warm) * 6.0) * 0.055;

  // One-step dither: the gradient is shallow, and YUYV output would band it.
  color += (hash(gl_FragCoord.xy) - 0.5) / 255.0;

  finalColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

export class Backdrop {
  /** Add this to the stage before the face. */
  readonly view = new Graphics()
    .rect(0, 0, ARTBOARD.width, ARTBOARD.height)
    .fill(FACE.backdrop.outer);

  readonly #filter: Filter;
  #seconds = 0;

  constructor() {
    this.view.label = "backdrop";

    this.#filter = Filter.from({
      gl: { vertex: defaultFilterVert, fragment: FRAGMENT },
      resources: {
        backdrop: {
          uTime: { value: 0, type: "f32" },
          uInner: { value: rgb(FACE.backdrop.inner), type: "vec3<f32>" },
          uOuter: { value: rgb(FACE.backdrop.outer), type: "vec3<f32>" },
          uCool: { value: rgb(FACE.backdrop.cool), type: "vec3<f32>" },
          uWarm: { value: rgb(FACE.backdrop.warm), type: "vec3<f32>" },
        },
      },
    });

    this.view.filterArea = new Rectangle(0, 0, ARTBOARD.width, ARTBOARD.height);
    // TEMP: isolate a WebKit compositing artifact.
    // this.view.filters = [this.#filter];
  }

  /** Advances the aurora. Call once per frame with the delta, in seconds. */
  update(dt: number): void {
    // The shader only needs a phase angle, so wrap it instead of letting the
    // float grow for the lifetime of the window.
    this.#seconds = (this.#seconds + dt) % 3600;
    this.#filter.resources.backdrop.uniforms.uTime = this.#seconds;
  }
}
