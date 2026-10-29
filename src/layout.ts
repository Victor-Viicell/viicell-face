/**
 * The window's geometry, as arithmetic.
 *
 * One docked column on the right holds every control and the status line; the
 * face gets the rest of the window, letterboxed to 16:9 at a whole-number scale
 * so the drawn face never lands on a half pixel. Nothing here touches the DOM,
 * a timer or the app: a window size and a panel state go in, rectangles come
 * out, and `bun test` pins the answers at every size the ticket names.
 */

/** A width and a height, in CSS pixels. */
export interface Size {
  width: number;
  height: number;
}

/** A box, in CSS pixels, measured from the window's top-left corner. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The docked column's remembered width, and whether it is folded away. */
export interface LayoutState {
  width: number;
  collapsed: boolean;
}

/**
 * The numbers the layout is built from.
 *
 * `inset` is both the gap to the window edge and the panel's own padding, so
 * the column reads as one block. `safeInset` is the part of the canvas the face
 * is not allowed to be covered on: chrome belongs in the panel, never here.
 */
export const CHROME = {
  /** Gap to the window edge, and the panel's inner padding. */
  inset: 12,
  /** Space between the stage column and the panel column. */
  gap: 0,
  /** A 16:9 image is never shrunk below this whole-number multiple. */
  minUnit: 4,
  /** The narrowest a control row may get before the panel is drawn wider. */
  minContent: 200,
  /** Widest the expanded column may be, whatever the store remembers. */
  maxPanel: 420,
  /** Narrowest the expanded column may be. */
  minPanel: 240,
  /** The folded strip: the toggle, and the state dot under it. */
  folded: 44,
  /** Share of the window the column may take before it is capped. */
  share: 0.42,
  /** The part of the canvas a control must never cover, as a share of it. */
  safeInset: 0.06,
  /** The canvas is a camera image; it keeps this shape in every window. */
  aspectWidth: 16,
  aspectHeight: 9,
} as const;

/** Everything the shell needs to place the stage and the panel. */
export interface Layout {
  /** The window the maths was run for. */
  window: Size;
  /** The column on the right; its width is what the CSS reserves. */
  panel: Rect;
  /** What is left for the face. */
  stage: Rect;
  /** The letterboxed 16:9 canvas inside the stage. */
  view: Rect;
  /** The part of the view the face is drawn in and nothing may cover. */
  safe: Rect;
  /** Usable width inside the panel, between its padding. */
  content: Rect;
  /** Whole-number multiple of 16×9 the view was snapped to; `0` when it could not be. */
  unit: number;
}

const clampInt = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(Number.isFinite(value) ? value : min)));

const empty = (x: number, y: number): Rect => ({ x, y, width: 0, height: 0 });

/**
 * How wide the docked column is this frame.
 *
 * The store remembers a width; the window has a veto. A narrow window caps the
 * column at {@link CHROME.share} of its usable width so the face never ends up
 * as a postage stamp beside an oversized panel, and shrinking below
 * {@link CHROME.minContent} would clip the controls, so the floor wins over the
 * remembered width. Folded, the column is one strip and nothing else.
 */
export function panelColumn(windowWidth: number, state: LayoutState): number {
  const room = Math.max(0, Math.round(Number.isFinite(windowWidth) ? windowWidth : 0) - CHROME.inset * 2);
  if (state.collapsed) {
    return Math.min(CHROME.folded, room);
  }
  const cap = Math.max(CHROME.folded, Math.min(CHROME.maxPanel, Math.round(room * CHROME.share)));
  const floor = Math.min(CHROME.minPanel, cap);
  return clampInt(state.width, floor, cap);
}

/**
 * The largest 16:9 box that fits `area`, centred, snapped to a whole multiple
 * of 16×9 so the scale is an integer and no edge lands on a half pixel.
 *
 * When the area is too small for even {@link CHROME.minUnit} the box is fitted
 * as-is (still centred, still 16:9) and `unit` is `0`, which is the honest answer
 * for a window that cannot hold the face at all.
 */
export function letterbox(area: Rect): { view: Rect; unit: number } {
  if (area.width <= 0 || area.height <= 0) {
    return { view: empty(area.x, area.y), unit: 0 };
  }
  const unit = Math.floor(Math.min(area.width / CHROME.aspectWidth, area.height / CHROME.aspectHeight));
  if (unit >= CHROME.minUnit) {
    const width = CHROME.aspectWidth * unit;
    const height = CHROME.aspectHeight * unit;
    return {
      view: {
        x: area.x + Math.floor((area.width - width) / 2),
        y: area.y + Math.floor((area.height - height) / 2),
        width,
        height,
      },
      unit,
    };
  }
  const fit = Math.min(area.width / CHROME.aspectWidth, area.height / CHROME.aspectHeight);
  const width = Math.max(1, Math.floor(fit * CHROME.aspectWidth));
  const height = Math.max(1, Math.round((width * CHROME.aspectHeight) / CHROME.aspectWidth));
  return {
    view: {
      x: area.x + Math.floor((area.width - width) / 2),
      y: area.y + Math.floor((area.height - height) / 2),
      width,
      height,
    },
    unit: 0,
  };
}

/** The face's margin inside the canvas: the band no control may sit on. */
export function safeArea(view: Rect): Rect {
  const inset = Math.round(Math.min(view.width, view.height) * CHROME.safeInset);
  const width = Math.max(0, view.width - inset * 2);
  const height = Math.max(0, view.height - inset * 2);
  return { x: view.x + inset, y: view.y + inset, width, height };
}

/**
 * The whole window, laid out.
 *
 * The panel owns the right edge and the full height; the stage is everything to
 * its left, and the canvas is letterboxed inside the stage's inset. Because the
 * chrome lives in the panel, no rectangle outside `panel` can cover `safe`.
 */
export function layoutFor(windowSize: Size, state: LayoutState): Layout {
  const width = Math.max(0, Math.round(Number.isFinite(windowSize.width) ? windowSize.width : 0));
  const height = Math.max(0, Math.round(Number.isFinite(windowSize.height) ? windowSize.height : 0));
  const column = Math.min(panelColumn(width, state), width);
  const stage: Rect = { x: 0, y: 0, width: Math.max(0, width - column), height };
  const panel: Rect = { x: stage.width, y: 0, width: column, height };

  const { view, unit } = letterbox({
    x: CHROME.inset,
    y: CHROME.inset + CHROME.gap,
    width: Math.max(0, stage.width - CHROME.inset * 2),
    height: Math.max(0, stage.height - CHROME.inset * 2 - CHROME.gap),
  });

  const content: Rect = {
    x: panel.x + CHROME.inset,
    y: CHROME.inset,
    width: Math.max(0, column - CHROME.inset * 2),
    height: Math.max(0, height - CHROME.inset * 2),
  };

  return { window: { width, height }, panel, stage, view, safe: safeArea(view), content, unit };
}
