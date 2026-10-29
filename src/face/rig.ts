/**
 * Builds the PixiJS face from the artwork + skeleton maps and exposes the bones
 * for posing.
 *
 * Bone transforms live in artboard units: every bone sits at its pivot with the
 * pivot as origin, so at rest all transforms are the identity and the shapes
 * line up with the source artwork. Rotating or scaling a bone therefore happens
 * around its joint, and children follow their parent.
 */

import { BlurFilter, Container, Graphics, GraphicsPath, Matrix, Text } from "pixi.js";
import {
  ARTBOARD,
  MOUTH,
  SHAPES,
  mouthBottomScale,
  mouthCornerShape,
  mouthOpenScale,
  type ShapeDef,
} from "./art";
import { Backdrop } from "./backdrop";
import { MOCHA } from "./palette";
import { paintToFill } from "./paint";
import { BONES, type BoneId, type BoneDef } from "./skeleton";

/** Extent of one bone's artwork, in artboard units. */
interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Swing added at pose amount 1, in radians. */
const BROW_SWING = 0.12;
const CHEEK_SWING = 0.09;

/**
 * Travel of the whole mouth at pose 1, in artboard units. The mouth bone pivots
 * at the middle of the mouth, so this is a pure translation: the lips, the gap
 * and both corner cuts move together instead of being stretched from the face.
 */
const MOUTH_SHIFT = { x: 80, y: 34 } as const;
/**
 * Twist of the whole mouth at pose 1, in radians (~9°) around the mouth's own
 * pivot. A head roll is already cancelled upstream, so this is the mouth's own
 * twist and stays out of the way of the eye line.
 */
const MOUTH_TILT = 0.16;

/**
 * How far past the rim a pupil may travel, as a multiplier on the room its
 * shell leaves. The mask clips the excess, so the pupil rides the edge.
 */
const RIM_OVERSHOOT = 1.4;
/**
 * Up and down get a longer leash: the disc already fills most of the eye's
 * height, so its own rim leaves too little room for an upward look to read.
 * At this value the pupil reaches the top and bottom of the shell.
 */
const RIM_OVERSHOOT_Y = 5;
/**
 * How much a full eye-wide pose shrinks the iris, as a fraction of its drawn
 * size, and how much it thins the pupil slit. The manual `V`/`B` sizes are the
 * base these multiply, so a bulge reads on top of whatever iris was chosen.
 */
const IRIS_WIDE_SHRINK = 0.3;
const PUPIL_WIDE_SHRINK = 0.5;

/**
 * How far the whole eye leans after the look, as a fraction of its own shell
 * half-size. The shell, iris and pupil travel together, so the eye reads as
 * turning towards the cursor instead of the pupil sliding inside a fixed disc.
 */
const LEAN_X = 0.16;
/** Vertical lean is gentler: the shells are taller than they are wide. */
const LEAN_Y = 0.075;
/**
 * Extra lean from the tracked head position, as a fraction of the shell
 * half-size. The camera mode uses it to turn the eyes with the head, on top of
 * the turn the look itself gives.
 */
const HEAD_LEAN_X = 0.24;
const HEAD_LEAN_Y = 0.135;
/**
 * Lean from the head itself turning, as a fraction of the shell half-size. This
 * is its own channel: turning or nodding the head slides the whole eye even
 * while the pupils stay centred, so the eyes answer the neck independently of
 * where the gaze is pointed.
 */
const HEAD_TURN_LEAN_X = 0.3;
const HEAD_TURN_LEAN_Y = 0.16;
/** How much of that lean the brow and cheek slashes take. They sit against the
 * eyes, so following the glance keeps the lids from cutting into a shell that
 * has slid out from under them.
 */
const LID_LEAN = 0.7;

/** Seconds for a held gaze to glide back onto the live look when released. */
const AIM_TAU = 0.07;
/** Look distance treated as arrived, in the -1..1 units of the gaze. */
const AIM_SNAP = 0.0015;

const SKELETON_COLOR = MOCHA.sky;

/** White: stencil masks only care that the shape is filled. */
const MASK_FILL = 0xffffff;

/** Bones that exist only to transform a cut in the mouth mask. */
const MOUTH_MASK_BONES: ReadonlySet<BoneId> = new Set([
  "mouthGap",
  "mouthCornerLeft",
  "mouthCornerRight",
]);

/**
 * Bloom around each pupil. The dark disc leaves the slit looking pasted on;
 * a blurred, additively blended copy behind it makes the eye read as lit from
 * inside. Strength is in output pixels, not artboard units.
 */
const PUPIL_GLOW = { strength: 14, quality: 4, alpha: 0.5 } as const;

/** Which of a mirrored pair a pose applies to. */
export type Side = "left" | "right";

const eyeOf = (side: Side): "eyeLeft" | "eyeRight" =>
  side === "left" ? "eyeLeft" : "eyeRight";
const browOf = (side: Side): "browLeft" | "browRight" =>
  side === "left" ? "browLeft" : "browRight";
const cheekOf = (side: Side): "cheekLeft" | "cheekRight" =>
  side === "left" ? "cheekLeft" : "cheekRight";
const cornerOf = (side: Side): "mouthCornerLeft" | "mouthCornerRight" =>
  side === "left" ? "mouthCornerLeft" : "mouthCornerRight";
const sidesOf = (side?: Side): readonly Side[] => (side ? [side] : ["left", "right"]);

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** One joint of the rig. */
export class Bone {
  constructor(
    readonly id: BoneId,
    readonly pivot: readonly [number, number],
    readonly node: Container,
    /** Told after any transform write, so derived geometry stays in sync. */
    readonly changed?: () => void,
  ) {}

  /** Rotation around the pivot, in radians. */
  get rotation(): number {
    return this.node.rotation;
  }

  set rotation(value: number) {
    this.node.rotation = value;
    this.changed?.();
  }

  /** Moves the bone away from its rest position, in artboard units. */
  moveBy(dx: number, dy: number): this {
    this.node.position.set(this.pivot[0] + dx, this.pivot[1] + dy);
    this.changed?.();
    return this;
  }

  /** Scales around the pivot. */
  scaleBy(x: number, y: number = x): this {
    this.node.scale.set(x, y);
    this.changed?.();
    return this;
  }

  /** Back to the rest pose. Children keep their own pose. */
  reset(): this {
    this.node.position.set(this.pivot[0], this.pivot[1]);
    this.node.rotation = 0;
    this.node.scale.set(1);
    this.changed?.();
    return this;
  }
}

export class FaceRig {
  /** Add this to the stage; it already covers the whole canvas. */
  readonly root = new Container({ label: "face-rig" });
  readonly bones: Record<BoneId, Bone>;
  /** The shader backdrop behind the face; `main.ts` advances its aurora. */
  readonly backdrop = new Backdrop();
  /** Joint/pivot overlay, hidden by default and never part of the camera feed. */
  readonly skeleton: Container;

  /** Extent of each bone's artwork, in artboard units. */
  #bounds = new Map<BoneId, Box>();
  /**
   * One stencil mask per eye: the artboard with the brow and cheek paths cut out
   * of it. The lids themselves are not drawn. The eye is kept everywhere except
   * under a lid, so the real backdrop shows through the cut instead of a dark
   * fill and the lid always blends.
   */
  #lidMasks = new Map<Side, Graphics>();
  /** The lid paths, tessellated once and reused by the live masks. */
  #lidPaths = new Map<BoneId, GraphicsPath>();
  /** Scratch transform for redrawing a lid cut, so a frame allocates nothing. */
  #lidMatrix = new Matrix();

  /** The mouth's inverse mask: the gap between the lips plus the corner cuts. */
  #mouthMask!: Container;
  #mouthCutout!: GraphicsPath;
  #mouthOpen: number = MOUTH.rest.open;
  #mouthWidth: number = MOUTH.rest.width;
  #mouthBottomWidth: number = MOUTH.rest.bottomWidth;
  /** Per-corner expression: -1 fully sad, 0 the flat happy cut, 1 no cut. */
  #mouthCorner: Record<Side, number> = {
    left: MOUTH.rest.corner,
    right: MOUTH.rest.corner,
  };
  /** Mouth offset from its rest place, -1..1 per axis. */
  #mouthShift = { x: 0, y: 0 };
  /** Mouth twist around its own centre, -1..1 (+ clockwise). */
  #mouthTilt = 0;

  /** Displacement each bone gets from the current look, in artboard units. */
  #lean = new Map<BoneId, { x: number; y: number }>();
  /**
   * Vertical scale each bone carries from a lid stretch or a blink, plus the
   * drift that scaling around the pivot causes.
   */
  #stretch = new Map<BoneId, { scaleY: number; dy: number }>();

  /** Iris multiplier, 1 = as drawn. */
  #irisScale = 1;
  /** Pupil slit width multiplier, 1 = as drawn. */
  #pupilWidth = 1;
  /** Eye widening from the tracker, 0..1. */
  #eyeWide = 0;
  /** Blink scale of each eye assembly, 1 = open. */
  #openness: Record<Side, number> = { left: 1, right: 1 };
  /** Last look direction, re-applied when the iris changes size. */
  #look = { x: 0, y: 0 };
  /**
   * Head position from the camera tracker, -1..1 per axis, as a separate lean
   * on top of the look's. Manual mode leaves it at zero.
   */
  #head = { x: 0, y: 0 };
  /**
   * How far the head itself is turned, -1..1 per axis, independent of the gaze.
   * Another lean on the eyes, so a turn moves them even with the pupils still.
   */
  #headTurn = { yaw: 0, pitch: 0 };
  /**
   * Direction the irises are aimed with. It holds still while the eyes are
   * frozen, and trails `#look` for a moment after, so the gaze never jumps.
   */
  #pupilAim = { x: 0, y: 0 };
  /** The gaze holds still while the lean keeps following the look. */
  #eyesFrozen = false;
  /** `performance.now()` of the previous aim step, for the easing. */
  #aimedAt = 0;

  constructor(scale: number) {
    this.root.scale.set(scale);

    // The backdrop is not a bone: it stays put whatever the face does.
    this.root.addChild(this.backdrop.view);

    const nodes = new Map<BoneId, Container>();
    for (const def of BONES) {
      nodes.set(def.id, new Container({ label: def.id }));
    }

    // Safe by construction: every id in BONES is defined above.
    this.bones = {} as Record<BoneId, Bone>;
    for (const def of BONES) {
      const node = nodes.get(def.id)!;
      node.position.set(def.pivot[0], def.pivot[1]);
      node.pivot.set(def.pivot[0], def.pivot[1]);
      this.bones[def.id] = new Bone(def.id, def.pivot, node, () => this.#syncLidMasks());
    }

    // Shapes go in before the child bones: children render after the shapes of
    // their parent, which is what puts the iris on top of the shell and the
    // pupil on top of the iris.
    for (const shape of SHAPES) {
      const graphics = createShape(shape);
      this.bones[shape.bone].node.addChild(graphics);

      // At rest the bone transform is the identity, so local bounds are in
      // artboard units. The eyelid stretches need to know the exact edges of
      // each slash and of the eye shells, and the irises need the room their
      // shells leave them.
      const bounds = graphics.getLocalBounds();

      // Brows and cheeks only define the lid masks; drawing them would paste a
      // dark shape over the eye instead of opening the eye onto the backdrop.
      if (shape.bone.startsWith("brow") || shape.bone.startsWith("cheek")) {
        graphics.visible = false;
      }

      const previous = this.#bounds.get(shape.bone);
      this.#bounds.set(shape.bone, {
        minX: Math.min(previous?.minX ?? Number.POSITIVE_INFINITY, bounds.minX),
        maxX: Math.max(previous?.maxX ?? Number.NEGATIVE_INFINITY, bounds.maxX),
        minY: Math.min(previous?.minY ?? Number.POSITIVE_INFINITY, bounds.minY),
        maxY: Math.max(previous?.maxY ?? Number.NEGATIVE_INFINITY, bounds.maxY),
      });
    }

    // The iris and pupil are clipped to the eye shell, so closing the eye trims
    // them at the lid instead of squashing them into a sliver. The mask lives
    // on the eye assembly, so it follows the blink scale with the shell.
    this.bones.eyeLeftIris.node.mask = createEyeMask("eyeLeft", nodes);
    this.bones.eyeRightIris.node.mask = createEyeMask("eyeRight", nodes);

    // Bloom goes under the pupil, so the slit stays crisp on top of its halo.
    this.#addPupilGlow("eyeLeftPupil");
    this.#addPupilGlow("eyeRightPupil");

    // Each eye is masked by its brow and cheek: the lid paths are cut out of a
    // full-artboard mask, so a lid removes the eye where it covers it. The
    // backdrop shows through instead of a near-black band over the blue shell.
    for (const side of ["left", "right"] as const) {
      this.#maskLid(side);
    }

    // Parenting in skeleton order also fixes the draw order between siblings.
    // The mask bones are added to the mouth mask below instead: they only exist
    // to transform the cuts, never to paint.
    for (const def of BONES) {
      if (MOUTH_MASK_BONES.has(def.id)) {
        continue;
      }
      const parent = def.parent ? nodes.get(def.parent)! : this.root;
      parent.addChild(nodes.get(def.id)!);
    }

    // The mouth is one inverse mask over three bones: the gap bone cuts the lips
    // apart, and each corner bone cuts its end of the smile. The mask is a child
    // of the mouth root, so it follows the width scale for free.
    this.#mouthCutout = new GraphicsPath(MOUTH.cutout);
    this.#mouthMask = new Container({ label: "mouthMask" });
    this.bones.mouth.node.addChild(this.#mouthMask);

    this.bones.mouthGap.node
      .addChild(new Graphics().path(this.#mouthCutout).fill(MASK_FILL));

    // Each corner cut is an ellipse drawn at the widest happy reference. Its
    // bone moves it to the current width and scales it into the happy/sad shape;
    // because the drawing is centred on the pivot, the scale needs no redraw.
    const corner = MOUTH.corner;
    for (const side of sidesOf()) {
      const centre = side === "left" ? corner.centre.max : ARTBOARD.width - corner.centre.max;
      this.bones[cornerOf(side)].node.addChild(
        new Graphics()
          .ellipse(
            centre,
            corner.top.max + corner.happyRadiusY.max,
            corner.radiusX.max,
            corner.happyRadiusY.max,
          )
          .fill(MASK_FILL),
      );
    }

    for (const id of MOUTH_MASK_BONES) {
      this.#mouthMask.addChild(this.bones[id].node);
    }

    this.bones.mouth.node.setMask({ mask: this.#mouthMask, inverse: true });
    this.resetMouth();

    this.skeleton = createSkeletonOverlay();
    this.skeleton.visible = false;
    this.root.addChild(this.skeleton);
  }

  /** A blurred additive copy of the pupil path, rendered behind the pupil. */
  #addPupilGlow(id: "eyeLeftPupil" | "eyeRightPupil"): void {
    const shape = SHAPES.find((candidate) => candidate.bone === id);
    if (!shape) {
      return;
    }

    const glow = new Graphics()
      .path(new GraphicsPath(shape.d))
      .fill({ color: MOCHA.blue, alpha: PUPIL_GLOW.alpha });
    glow.blendMode = "add";
    glow.filters = [new BlurFilter({ strength: PUPIL_GLOW.strength, quality: PUPIL_GLOW.quality })];

    this.bones[id].node.addChildAt(glow, 0);
  }

  /**
   * Builds one eye's lid mask from its brow and cheek paths.
   *
   * The mask is a full-artboard shape with each lid cut out of it, held under the
   * face bone and redrawn from the bones' transforms. Applied normally to the
   * eye assembly, it keeps the eye everywhere except under a lid, so the backdrop
   * shows through the cut instead of a dark fill. No shell clip is needed because
   * the eye has no pixels outside its shell.
   */
  #maskLid(side: Side): void {
    const mask = new Graphics({ label: `lidMask-${side}` });
    // The mask lives in face-local space, like the lids themselves.
    this.bones.face.node.addChild(mask);
    mask.includeInBuild = false;

    for (const id of [browOf(side), cheekOf(side)]) {
      const shape = SHAPES.find((candidate) => candidate.bone === id);
      if (shape) {
        this.#lidPaths.set(id, new GraphicsPath(shape.d));
      }
    }

    this.#lidMasks.set(side, mask);
    // A normal stencil mask: the artboard with the lids as holes. It can wrap
    // the eye's own shell mask without nesting two inverted masks, which Pixi
    // cannot combine in one stencil.
    this.bones[eyeOf(side)].node.mask = mask;
    this.#syncLidMasks();
  }

  /**
   * Redraws each eye's mask from the current lid transforms.
   *
   * The artboard rectangle is the keep-out area; each lid is cut out of it at
   * its own pivot, scale and rotation, so the eye disappears exactly where the
   * lid has stretched over it. Reusing the tessellated paths keeps the per-frame
   * cost to two transforms and two cuts per eye.
   */
  #syncLidMasks(): void {
    for (const [side, mask] of this.#lidMasks) {
      mask.clear();
      mask.rect(0, 0, ARTBOARD.width, ARTBOARD.height).fill(0xffffff);

      for (const id of [browOf(side), cheekOf(side)]) {
        const path = this.#lidPaths.get(id);
        if (!path) {
          continue;
        }
        const bone = this.bones[id];
        const node = bone.node;
        this.#lidMatrix.setTransform(
          node.position.x,
          node.position.y,
          node.pivot.x,
          node.pivot.y,
          node.scale.x,
          node.scale.y,
          node.rotation,
          0,
          0,
        );
        mask.setTransform(this.#lidMatrix);
        mask.path(path).cut();
        mask.resetTransform();
      }
    }
  }

  /**
   * Rescales the whole face for a new canvas size.
   *
   * Everything is drawn on a 1920×1080 artboard, so a size change is one number
   * for the rig; the canvas buffer, the tick rate and the v4l2 format are the
   * other halves of the same change (see `applyOutput` in `stream.ts`).
   */
  setScale(scale: number): this {
    this.root.scale.set(scale);
    return this;
  }

  /** 0 = eyes open, 1 = shut. Closes both shells; the mask trims the iris. */
  setEyeClose(amount: number, side?: Side): this {
    if (side) {
      return this.#setEyeClose(side, amount);
    }
    this.#setEyeClose("left", amount);
    this.#setEyeClose("right", amount);
    return this;
  }

  #setEyeClose(side: Side, amount: number): this {
    const openness = 1 - clamp(amount, 0, 1) * 0.96;
    this.#openness[side] = openness;
    this.#stretch.set(eyeOf(side), { scaleY: openness, dy: 0 });
    this.#applyIris();
    // The lean fades with the lids, so a shut eye never slides out from under
    // the brow or cheek that is pinned to its rest outline.
    this.#leanFace();
    return this;
  }

  /**
   * Head offset, -1..1 per axis (x → right, y → down), as seen by the tracking
   * camera. Adds a lean to the eyes on top of the one the look already gives;
   * manual mode keeps it at zero.
   *
   * `yaw` and `pitch` are the head's own turn (-1..1, right and down). They are
   * a separate channel from the look: a turn slides the whole eye even when the
   * pupils stay centred.
   */
  setHead(x: number, y: number, yaw = 0, pitch = 0): this {
    this.#head = { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
    this.#headTurn = { yaw: clamp(yaw, -1, 1), pitch: clamp(pitch, -1, 1) };
    this.#leanFace();
    return this;
  }

  /**
   * 1 = the iris as drawn. Below 1 the dark disc shrinks, above 1 it grows;
   * the eye shell masks whatever would spill outside, so it stays an eye.
   */
  setIrisScale(scale: number): this {
    this.#irisScale = clamp(scale, 0.4, 1.6);
    this.#applyIris();
    // The travel is the drawn eye's and does not change with the size; re-aiming
    // only re-applies the current look at the new scale.
    this.#applyLook(this.#look.x, this.#look.y);
    return this;
  }

  /**
   * 0 = rest, 1 = the brow bands stretched down to the bottom of the eyes.
   * The top edge of each brow stays where it is and the bottom edge drops.
   * A side moves only that brow; without one both move.
   */
  setBrowClose(amount: number, side?: Side): this {
    for (const current of sidesOf(side)) {
      const shell = this.#bounds.get(`${eyeOf(current)}Shell`);
      if (shell) {
        this.#stretchTo(browOf(current), "top", shell.maxY, amount);
      }
    }
    return this;
  }

  /**
   * 0 = rest, 1 = the cheek bands stretched up to the top of the eyes.
   * The bottom edge of each cheek stays where it is and the top edge rises.
   * A side moves only that cheek; without one both move.
   */
  setCheekClose(amount: number, side?: Side): this {
    for (const current of sidesOf(side)) {
      const shell = this.#bounds.get(`${eyeOf(current)}Shell`);
      if (shell) {
        this.#stretchTo(cheekOf(current), "bottom", shell.minY, amount);
      }
    }
    return this;
  }

  /**
   * Scales a bone vertically so one horizontal edge of its artwork reaches
   * `target`, keeping the opposite edge pinned. Scaling happens around the
   * pivot, so the node is also shifted to undo the drift that causes.
   */
  #stretchTo(id: BoneId, anchor: "top" | "bottom", target: number, amount: number): void {
    const bounds = this.#bounds.get(id);
    if (!bounds) {
      return;
    }

    const pinned = anchor === "top" ? bounds.minY : bounds.maxY;
    const moving = anchor === "top" ? bounds.maxY : bounds.minY;
    // Scale that carries the moving edge exactly onto the target.
    const full = (target - pinned) / (moving - pinned);
    const scale = 1 + (full - 1) * clamp(amount, 0, 1);

    const bone = this.bones[id];
    const pivotY = bone.pivot[1];
    this.#stretch.set(id, { scaleY: scale, dy: (pinned - pivotY) * (1 - scale) });
    this.#pose(id);
  }

  /**
   * Writes a bone's stance from the stretch and the lean. Both want to move the
   * same node, so every writer goes through here instead of setting the
   * transform itself.
   */
  #pose(id: BoneId): void {
    const bone = this.bones[id];
    const lean = this.#lean.get(id);
    const stretch = this.#stretch.get(id);
    bone.node.position.set(
      bone.pivot[0] + (lean?.x ?? 0),
      bone.pivot[1] + (lean?.y ?? 0) + (stretch?.dy ?? 0),
    );
    bone.node.scale.set(1, stretch?.scaleY ?? 1);
    this.#syncLidMasks();
  }

  /**
   * Scales the dark disc. The blink scale is cancelled on Y, so the iris keeps
   * its drawn height while the lids come down and the shell mask trims it.
   */
  #applyIris(): void {
    const x = this.#irisSize();
    this.bones.eyeLeftIris.node.scale.set(x, x / this.#openness.left);
    this.bones.eyeRightIris.node.scale.set(x, x / this.#openness.right);
  }

  /** Iris scale with the tracked eye-wide shrink applied. */
  #irisSize(): number {
    return this.#irisScale * (1 - IRIS_WIDE_SHRINK * this.#eyeWide);
  }

  /** Look direction, -1..1 per axis (x → right, y → down). Moves both irises. */
  setLook(x: number, y: number): this {
    this.#applyLook(clamp(x, -1, 1), clamp(y, -1, 1));
    return this;
  }

  /**
   * Look direction from a source that already smooths its own signal.
   *
   * The camera tracker eases its readings before handing them over, so the aim
   * is written straight through. Easing here as well would stack a second lag
   * and make the eyes trail the gaze instead of following it.
   */
  setTrackedLook(x: number, y: number): this {
    this.#applyLook(clamp(x, -1, 1), clamp(y, -1, 1), false);
    return this;
  }

  /**
   * Aims both eyes at a spot on the screen, given as 0..1 across the desktop
   * (0,0 = top left corner).
   *
   * Both pupils take the same direction, but each one uses the room its own
   * shell leaves, so they are never held at a fixed distance from each other.
   */
  setGaze(u: number, v: number): this {
    this.#applyLook(clamp((u - 0.5) * 2, -1, 1), clamp((v - 0.5) * 2, -1, 1));
    return this;
  }

  /**
   * Slides each iris towards a direction, as far as its own eye allows.
   *
   * The artwork is not symmetric about the iris — the blue shell reaches
   * further out of the face than into it — so the two pupils do not travel the
   * same distance, and the pair does not keep a constant spacing. Using the
   * room its own shell leaves, and riding slightly past it, is what makes the
   * direction obvious at a glance; the shell mask trims whatever leaves the
   * eye, so the pupil reads as pressed against the edge.
   */
  #applyLook(x: number, y: number, ease = true): void {
    const now = performance.now();
    const dt = this.#aimedAt === 0 ? 0 : Math.min(0.1, Math.max(0, (now - this.#aimedAt) / 1000));
    this.#aimedAt = now;

    this.#look = { x, y };
    // The lean always follows the look: it is the one thing a freeze leaves
    // running, so the eye keeps drifting as a whole.
    this.#leanFace();

    if (!this.#eyesFrozen) {
      if (!ease) {
        // The caller already smoothed the signal (the camera tracker).
        this.#pupilAim.x = x;
        this.#pupilAim.y = y;
      } else {
        const dx = x - this.#pupilAim.x;
        const dy = y - this.#pupilAim.y;
        if (Math.abs(dx) > AIM_SNAP || Math.abs(dy) > AIM_SNAP) {
          // Letting go: the aim glides from where it was held onto the live look,
          // so the gaze never jumps.
          const alpha = 1 - Math.exp(-dt / AIM_TAU);
          this.#pupilAim.x += dx * alpha;
          this.#pupilAim.y += dy * alpha;
        } else {
          // Ordinary tracking: no extra lag on top of the gaze easing.
          this.#pupilAim.x = x;
          this.#pupilAim.y = y;
        }
      }
    }

    this.#aimIris("eyeLeft", this.bones.eyeLeftIris);
    this.#aimIris("eyeRight", this.bones.eyeRightIris);
  }

  /**
   * Turns the face towards the look and the tracked head. Each eye shifts as a
   * whole — shell, iris and pupil — from three independent parts: where the gaze
   * points, where the head sits in the frame, and how far the head itself is
   * turned. The brows and cheeks follow at a fraction, so the slashes keep their
   * distance from a shell that is leaning past them.
   */
  #leanFace(): void {
    const shell = this.#bounds.get("eyeLeftShell");
    if (!shell) {
      return;
    }

    // A shut eye does not lean: the lid is pinned to its rest outline, and a
    // sliding shell would cut into it. With one eye shut, the open one still
    // leads the pair, so use the larger openness.
    const open = Math.max(this.#openness.left, this.#openness.right);
    const halfW = (shell.maxX - shell.minX) / 2;
    const halfH = (shell.maxY - shell.minY) / 2;
    const leanX =
      (this.#look.x * LEAN_X +
        this.#head.x * HEAD_LEAN_X +
        this.#headTurn.yaw * HEAD_TURN_LEAN_X) *
      halfW *
      open;
    const leanY =
      (this.#look.y * LEAN_Y +
        this.#head.y * HEAD_LEAN_Y +
        this.#headTurn.pitch * HEAD_TURN_LEAN_Y) *
      halfH *
      open;

    this.#setLean("eyeLeft", leanX, leanY);
    this.#setLean("eyeRight", leanX, leanY);

    for (const lid of ["browLeft", "browRight", "cheekLeft", "cheekRight"] as const) {
      this.#setLean(lid, leanX * LID_LEAN, leanY * LID_LEAN);
    }
  }

  #setLean(id: BoneId, x: number, y: number): void {
    this.#lean.set(id, { x, y });
    this.#pose(id);
  }

  #aimIris(eye: "eyeLeft" | "eyeRight", iris: Bone): void {
    // The gaze map is tied to the eye as drawn, never to the current iris size:
    // resizing the iris (by hand or by a bulge) must not change how far a given
    // look moves the eye, or the monitor calibration would drift. The shell mask
    // trims whatever a large disc spills past the edge, so no clamp is needed.
    const travel = this.#lookRoom(eye, iris);
    const { x, y } = this.#pupilAim;
    // The iris travels with its shell: a freeze stops the gaze, not the lean, so
    // there is nothing to compensate here — the whole eye moves as one piece.
    iris.moveBy(
      x >= 0 ? x * travel.maxX : x * -travel.minX,
      y >= 0 ? y * travel.maxY : y * -travel.minY,
    );
  }

  /**
   * How far an iris may travel for the gaze, in artboard units: negative to the
   * left/up, positive to the right/down. This is measured once, for the iris as
   * drawn, so it does not move with the current size. `RIM_OVERSHOOT` lets the
   * travel pass the shell edge, which the mask trims, so the pupil always
   * reaches the rim instead of stopping short of it.
   */
  #lookRoom(eye: "eyeLeft" | "eyeRight", iris: Bone): Box {
    const shell = this.#bounds.get(`${eye}Shell`);
    const disc = this.#bounds.get(`${eye}Iris`);
    if (!shell || !disc) {
      return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    }

    const halfW = (disc.maxX - disc.minX) / 2;
    const halfH = (disc.maxY - disc.minY) / 2;
    const [cx, cy] = iris.pivot;

    return {
      minX: Math.min(0, shell.minX - cx + halfW) * RIM_OVERSHOOT,
      maxX: Math.max(0, shell.maxX - cx - halfW) * RIM_OVERSHOOT,
      minY: Math.min(0, shell.minY - cy + halfH) * RIM_OVERSHOOT_Y,
      maxY: Math.max(0, shell.maxY - cy - halfH) * RIM_OVERSHOOT_Y,
    };
  }

  /**
   * Stops the gaze while the lean keeps running.
   *
   * The eyes keep drifting with the cursor exactly as they always do, and the
   * pupils ride along with their shells, but they stop looking around: the aim
   * is held where it was. Releasing glides it onto the live look over a moment.
   */
  setEyesFrozen(frozen: boolean): this {
    if (frozen === this.#eyesFrozen) {
      return this;
    }
    this.#eyesFrozen = frozen;
    this.#applyLook(this.#look.x, this.#look.y);
    return this;
  }

  /** Pupil slit width; 1 = as drawn. */
  setPupilWidth(multiplier: number): this {
    this.#pupilWidth = clamp(multiplier, 0.2, 3);
    this.#applyPupil();
    return this;
  }

  #applyPupil(): void {
    const width = this.#pupilWidth * (1 - PUPIL_WIDE_SHRINK * this.#eyeWide);
    this.bones.eyeLeftPupil.scaleBy(width, 1);
    this.bones.eyeRightPupil.scaleBy(width, 1);
  }

  /**
   * 0 = rest, 1 = the eyes bulged wide. Shrinks the iris and thins the pupil
   * slit on top of the sizes set by hand: a wide eye shows less of the dark
   * disc and a narrower slit.
   */
  setEyeWide(amount: number): this {
    this.#eyeWide = clamp(amount, 0, 1);
    this.#applyIris();
    // A smaller disc has more room to travel, so re-aim it in its new size.
    this.#aimIris("eyeLeft", this.bones.eyeLeftIris);
    this.#aimIris("eyeRight", this.bones.eyeRightIris);
    this.#applyPupil();
    return this;
  }

  /** 0 = rest, 1 = outer ends lifted, negative lowers them. */
  setBrowRaise(amount: number): this {
    const swing = clamp(amount, -1, 1) * BROW_SWING;
    this.bones.browLeft.rotation = swing;
    this.bones.browRight.rotation = -swing;
    return this;
  }

  /** 0 = rest, 1 = outer ends lifted (a smile), negative drops them. */
  setCheekLift(amount: number): this {
    const swing = clamp(amount, -1, 1) * CHEEK_SWING;
    this.bones.cheekLeft.rotation = swing;
    this.bones.cheekRight.rotation = -swing;
    return this;
  }

  /**
   * 0 = shut, 1 = fully open. The lower lip scales down from its top edge, so it
   * drops behind the upper lip and the fixed gap decides how much shows.
   */
  setMouthOpen(amount: number): this {
    this.#mouthOpen = clamp(amount, 0, 1);
    this.#applyMouth();
    return this;
  }

  /** 0 = the narrow reference mouth, 1 = the wide one. */
  setMouthWidth(amount: number): this {
    this.#mouthWidth = clamp(amount, 0, 1);
    this.#applyMouth();
    return this;
  }

  /** 0 = the narrow lower lip, 1 = the wide one, on top of the mouth width. */
  setMouthBottomWidth(amount: number): this {
    this.#mouthBottomWidth = clamp(amount, 0, 1);
    this.#applyMouth();
    return this;
  }

  /**
   * -1 = a full sad cut, 0 = the flat happy cut of the reference artwork, and 1
   * = no cut at all, which leaves the corner at its most upturned.
   *
   * The cut is a hole in the mouth mask, so a sad corner reveals the backdrop
   * rather than a dark patch, and each side moves on its own.
   */
  setMouthCorner(side: Side, amount: number): this {
    this.#mouthCorner[side] = clamp(amount, -1, 1);
    this.#syncMouthCorners();
    return this;
  }

  /**
   * Moves and twists the whole mouth from the camera: `x` and `y` are -1..1 and
   * `tilt` is -1..1 (+ clockwise).
   *
   * The mouth bone pivots at the middle of the mouth, so `x`/`y` translate the
   * lips, the gap and both corner cuts as one piece, and `tilt` turns them about
   * themselves. Nothing here swings the mouth from the face centre: a corner
   * moving to the side keeps the lip line level.
   */
  setMouthPose(x: number, y: number, tilt: number): this {
    this.#mouthShift = { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
    this.#mouthTilt = clamp(tilt, -1, 1);
    this.#applyMouthPose();
    return this;
  }

  /** The resting smile, used by manual mode and when tracking lets go. */
  resetMouth(): this {
    this.#mouthOpen = MOUTH.rest.open;
    this.#mouthWidth = MOUTH.rest.width;
    this.#mouthBottomWidth = MOUTH.rest.bottomWidth;
    this.#mouthCorner.left = MOUTH.rest.corner;
    this.#mouthCorner.right = MOUTH.rest.corner;
    this.#mouthShift = { x: 0, y: 0 };
    this.#mouthTilt = 0;
    this.#applyMouthPose();
    this.#applyMouth();
    return this;
  }

  /** Writes the mouth scales and the corner cut transforms. */
  #applyMouth(): void {
    this.bones.mouth.node.scale.x = lerp(MOUTH.width.min, MOUTH.width.max, this.#mouthWidth);
    this.bones.mouthBottom.node.scale.set(
      mouthBottomScale(this.#mouthBottomWidth, this.#mouthOpen),
      mouthOpenScale(this.#mouthOpen),
    );
    this.#syncMouthCorners();
  }

  /**
   * Writes the mouth's place and twist. Kept apart from `#applyMouth`, which
   * shapes the lips, so a pose update never touches that shape.
   */
  #applyMouthPose(): void {
    const bone = this.bones.mouth;
    bone.node.position.set(
      bone.pivot[0] + this.#mouthShift.x * MOUTH_SHIFT.x,
      bone.pivot[1] + this.#mouthShift.y * MOUTH_SHIFT.y,
    );
    bone.node.rotation = this.#mouthTilt * MOUTH_TILT;
  }

  /**
   * Moves and scales each corner cut for the current width and expression.
   *
   * The cut graphics are drawn at the widest happy reference and centred on their
   * bone pivots, so a scale is the whole shape change. Their positions are in
   * mouth-root space, so the root width scale is divided out to land on the
   * artboard position the reference gives for this width.
   */
  #syncMouthCorners(): void {
    const rootScale = this.bones.mouth.node.scale.x;

    for (const side of sidesOf()) {
      const shape = mouthCornerShape(this.#mouthWidth, this.#mouthCorner[side]);
      const centre = side === "left" ? shape.centre : ARTBOARD.width - shape.centre;

      const node = this.bones[cornerOf(side)].node;
      node.position.set(960 + (centre - 960) / rootScale, shape.centreY);
      node.scale.set(
        shape.radiusX / (MOUTH.corner.radiusX.max * rootScale),
        shape.radiusY / MOUTH.corner.happyRadiusY.max,
      );
    }
  }

  /** Every bone back to its rest pose, including any eyelid stretch. */
  rest(): this {
    this.#irisScale = 1;
    this.#pupilWidth = 1;
    this.#eyeWide = 0;
    this.#openness = { left: 1, right: 1 };
    this.#head = { x: 0, y: 0 };
    this.#headTurn = { yaw: 0, pitch: 0 };
    this.#look = { x: 0, y: 0 };
    this.#pupilAim = { x: 0, y: 0 };
    this.#lean.clear();
    this.#stretch.clear();
    for (const bone of Object.values(this.bones)) {
      bone.reset();
    }
    this.resetMouth();
    this.#syncLidMasks();
    return this;
  }
}

function createShape(shape: ShapeDef, outline = true): Graphics {
  const graphics = new Graphics()
    .path(new GraphicsPath(shape.d))
    .fill(paintToFill(shape.paint));
  if (outline && shape.stroke) {
    graphics.stroke(shape.stroke);
  }
  return graphics;
}

/**
 * Builds the mask that clips an iris (and its pupil) to its eye shell.
 *
 * The mask uses the shell path and is parented to the eye assembly rather than
 * to the shell bone, so it inherits the blink scale without needing updates.
 * `includeInBuild` is cleared so the stencil shape is never drawn as colour;
 * Pixi toggles it back on while it renders the mask into the stencil buffer.
 */
function createEyeMask(
  eye: "eyeLeft" | "eyeRight",
  nodes: Map<BoneId, Container>,
): Graphics {
  const shell = SHAPES.find((shape) => shape.bone === `${eye}Shell`)!;
  // Without the outline: the stroke would widen the stencil a pixel or two, and
  // the mask should be the shell's filled area exactly.
  const mask = createShape(shell, false);
  mask.includeInBuild = false;
  nodes.get(eye)!.addChild(mask);
  return mask;
}

function createSkeletonOverlay(): Container {
  const layer = new Container({ label: "skeleton" });
  const byId = new Map<BoneId, BoneDef>(BONES.map((bone) => [bone.id, bone]));
  // Nested bones share a pivot; stack their labels instead of overprinting them.
  const labelsPerPivot = new Map<string, number>();
  // Labels already placed, so a crowded joint can push the next one clear.
  const placed: { x: number; y: number; width: number; height: number }[] = [];
  const LABEL_HEIGHT = 22;

  for (const bone of BONES) {
    const pivotKey = `${bone.pivot[0]}:${bone.pivot[1]}`;
    const labelIndex = labelsPerPivot.get(pivotKey) ?? 0;
    labelsPerPivot.set(pivotKey, labelIndex + 1);

    if (bone.parent) {
      const { pivot: parentPivot } = byId.get(bone.parent)!;
      layer.addChild(
        new Graphics()
          .moveTo(parentPivot[0], parentPivot[1])
          .lineTo(bone.pivot[0], bone.pivot[1])
          .stroke({ color: SKELETON_COLOR, width: 2, alpha: 0.5 }),
      );
    }

    layer.addChild(
      new Graphics().circle(bone.pivot[0], bone.pivot[1], 6).fill({ color: SKELETON_COLOR, alpha: 0.9 }),
    );

    // Monospace 18px is about 11px per character; the estimate only has to be
    // good enough to tell whether two labels sit on top of each other.
    const x = bone.pivot[0] + 10;
    const width = bone.id.length * 11;
    let y = bone.pivot[1] + 8 + labelIndex * LABEL_HEIGHT;
    while (
      placed.some(
        (other) =>
          x < other.x + other.width &&
          x + width > other.x &&
          y < other.y + other.height &&
          y + LABEL_HEIGHT > other.y,
      )
    ) {
      y += LABEL_HEIGHT;
    }
    placed.push({ x, y, width, height: LABEL_HEIGHT });

    const label = new Text({
      text: bone.id,
      style: { fontFamily: "monospace", fontSize: 18, fill: SKELETON_COLOR },
    });
    label.position.set(x, y);
    layer.addChild(label);
  }

  return layer;
}
