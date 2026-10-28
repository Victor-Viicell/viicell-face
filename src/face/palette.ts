/**
 * Catppuccin Mocha, and the semantic colours of the face.
 *
 * The source artwork used three flat colours: `#79a8db` for the eye shells,
 * `#11111b` for the backdrop, lines and irises, and `#89b4fa` for the pupils.
 * The rig now paints from the Catppuccin palette instead, keeping the same
 * roles but giving each surface a little range: the shells are a cyan-to-blue
 * gradient, the pupils run from lavender to sapphire, and the backdrop lifts
 * from Mantle at the centre to Crust at the edges.
 *
 * Tokens are plain `#rrggbb` strings, so the same value can go into a Pixi
 * fill, a CSS declaration or a `<canvas>` style without conversion.
 */

export const MOCHA = {
  rosewater: "#f5e0dc",
  flamingo: "#f2cdcd",
  pink: "#f5c2e7",
  mauve: "#cba6f7",
  red: "#f38ba8",
  maroon: "#eba0ac",
  peach: "#fab387",
  yellow: "#f9e2af",
  green: "#a6e3a1",
  teal: "#94e2d5",
  sky: "#89dceb",
  sapphire: "#74c7ec",
  blue: "#89b4fa",
  lavender: "#b4befe",
  text: "#cdd6f4",
  subtext1: "#bac2de",
  subtext0: "#a6adc8",
  overlay2: "#9399b2",
  overlay1: "#7f849c",
  overlay0: "#6c7086",
  surface2: "#585b70",
  surface1: "#45475a",
  surface0: "#313244",
  base: "#1e1e2e",
  mantle: "#181825",
  crust: "#11111b",
} as const;

export type MochaColor = keyof typeof MOCHA;

/**
 * Which palette entry each part of the face uses.
 *
 * `line` is deliberately almost the backdrop colour: the brow and cheek slashes
 * are eyelids that are meant to disappear at rest and only show when they
 * stretch over a shell.
 */
export const FACE = {
  backdrop: {
    inner: MOCHA.mantle,
    outer: MOCHA.crust,
    cool: MOCHA.sapphire,
    warm: MOCHA.mauve,
  },
  shell: {
    top: MOCHA.sky,
    middle: MOCHA.blue,
    bottom: MOCHA.sapphire,
  },
  iris: {
    inner: MOCHA.base,
    middle: MOCHA.mantle,
    outer: MOCHA.crust,
    rim: MOCHA.blue,
  },
  pupil: {
    top: MOCHA.lavender,
    middle: MOCHA.blue,
    bottom: MOCHA.sapphire,
  },
  line: {
    top: MOCHA.mantle,
    bottom: MOCHA.crust,
  },
  mouth: {
    left: MOCHA.sapphire,
    middle: MOCHA.blue,
    right: MOCHA.mauve,
    tip: MOCHA.lavender,
    base: MOCHA.sapphire,
    cap: MOCHA.lavender,
  },
} as const;

/** `#rrggbb` to normalised `[r, g, b]`, the form a shader uniform wants. */
export function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}
