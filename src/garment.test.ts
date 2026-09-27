import { describe, expect, it } from 'vitest';
import { garmentControls, measureGarment, readBody, walkPolyline, type Body, type GarmentShape } from './garment';
import type { RowEdges } from './image-bounds';
import type { ControlPair } from './mls';

/** Builds an outline from per-row half widths, centered on 0.5. */
function outline(halves: number[]): Array<RowEdges | null> {
  return halves.map((h) => (h <= 0 ? null : { left: 0.5 - h, right: 0.5 + h }));
}

/**
 * A shirt outline shaped like the product photos: a narrow collar, a steep shoulder flare,
 * then either sleeves easing further out before the body narrows, or a straight hanging body.
 */
function shirtRows(options: { sleeveHalf?: number; bodyHalf?: number } = {}): Array<RowEdges | null> {
  const { sleeveHalf = 0, bodyHalf = 0.35 } = options;
  const shoulderHalf = 0.35;
  const halves: number[] = [];
  for (let i = 0; i < 100; i++) {
    if (i < 9) halves.push(0.1);
    else if (i < 15) halves.push(0.1 + ((i - 8) / 6) * (shoulderHalf - 0.1));
    else if (sleeveHalf > 0 && i < 31) halves.push(shoulderHalf + ((i - 15) / 16) * (sleeveHalf - shoulderHalf));
    else halves.push(bodyHalf);
  }
  return outline(halves);
}

describe('measureGarment', () => {
  it('finds the shoulder seam where the outline stops flaring', () => {
    const shape = measureGarment(shirtRows(), 1.3)!;
    expect(shape.shoulderY).toBeGreaterThan(0.15);
    expect(shape.shoulderY).toBeLessThan(0.32);
    expect(shape.shoulderHalf).toBeGreaterThan(0.25);
    expect(shape.center).toBeCloseTo(0.5, 1);
  });

  it('places the hip line below the shoulder seam, even past the hem of a short garment', () => {
    const shape = measureGarment(shirtRows(), 1.3)!;
    expect(shape.hipY).toBeGreaterThan(shape.shoulderY);
    const short = measureGarment(shirtRows({ sleeveHalf: 0.5, bodyHalf: 0.25 }), 0.9)!;
    expect(short.hipY).toBeGreaterThan(1);
  });

  it('ignores a hanging body that never reaches past the shoulders', () => {
    expect(measureGarment(shirtRows(), 1.3)!.sleeves).toBeNull();
  });

  it('ignores a wide hem that is no broader than the body above it', () => {
    expect(measureGarment(shirtRows({ sleeveHalf: 0.4, bodyHalf: 0.4 }), 1.3)!.sleeves).toBeNull();
  });

  it('finds cuffs when the sleeves spread out', () => {
    const shape = measureGarment(shirtRows({ sleeveHalf: 0.5, bodyHalf: 0.25 }), 1.3)!;
    expect(shape.sleeves).not.toBeNull();
    expect(shape.sleeves!.left.x).toBeCloseTo(0, 1);
    expect(shape.sleeves!.right.y).toBeLessThan(0.6);
  });

  it('returns null for an outline too short to measure', () => {
    expect(measureGarment(outline([0.4, 0.4]), 1)).toBeNull();
  });
});

describe('readBody', () => {
  const lm = (over: Record<number, { x: number; y: number; visibility?: number }>) => {
    const out = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0 }));
    for (const [i, p] of Object.entries(over)) out[Number(i)] = { visibility: 1, ...p };
    return out;
  };
  const shoulders = { 11: { x: 0.7, y: 0.5 }, 12: { x: 0.3, y: 0.5 } };

  it('returns null when a shoulder is hidden', () => {
    expect(readBody(lm({ 11: { x: 0.7, y: 0.5, visibility: 0.1 }, 12: { x: 0.3, y: 0.5 } }), 100, 100)).toBeNull();
  });

  it('uses real hips when they are visible', () => {
    const body = readBody(lm({ ...shoulders, 23: { x: 0.65, y: 0.9 }, 24: { x: 0.35, y: 0.9 } }), 100, 100)!;
    expect(body.hipLeft.y).toBeCloseTo(90);
  });

  it('projects hips down the torso when they are out of view', () => {
    const body = readBody(lm(shoulders), 100, 100)!;
    expect(body.hipLeft.y).toBeGreaterThan(body.shoulderLeft.y);
    expect(body.hipLeft.x).toBeLessThan(body.hipRight.x);
  });

  it('drops an arm whose elbow is not confidently seen', () => {
    const body = readBody(lm({ ...shoulders, 14: { x: 0.2, y: 0.7, visibility: 0.2 } }), 100, 100)!;
    expect(body.armLeft).toBeNull();
  });

  it('keeps an arm that stops at the elbow', () => {
    const body = readBody(lm({ ...shoulders, 14: { x: 0.2, y: 0.7 } }), 100, 100)!;
    expect(body.armLeft).toHaveLength(2);
  });
});

describe('walkPolyline', () => {
  const line = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];

  it('walks along the first segment', () => {
    expect(walkPolyline(line, 4)).toEqual({ x: 4, y: 0 });
  });

  it('carries on into the second segment', () => {
    expect(walkPolyline(line, 13)).toEqual({ x: 10, y: 3 });
  });

  it('stops at the end when asked to go further', () => {
    expect(walkPolyline(line, 100)).toEqual({ x: 10, y: 10 });
  });
});

describe('garmentControls', () => {
  const shape: GarmentShape = {
    shoulderY: 0.2,
    shoulderHalf: 0.35,
    center: 0.5,
    hipY: 1.1,
    hipHalf: 0.3,
    sleeves: { left: { x: 0.02, y: 0.3 }, right: { x: 0.98, y: 0.3 } },
  };
  const image = { width: 600, height: 800 };
  const body: Body = {
    shoulderLeft: { x: 100, y: 100 },
    shoulderRight: { x: 300, y: 100 },
    hipLeft: { x: 110, y: 400 },
    hipRight: { x: 290, y: 400 },
    armLeft: [{ x: 100, y: 100 }, { x: 40, y: 220 }, { x: 20, y: 340 }],
    armRight: [{ x: 300, y: 100 }, { x: 360, y: 220 }, { x: 380, y: 340 }],
  };
  const span = 200;
  const NECK = 0, SHOULDER_L = 1, SHOULDER_R = 2, HIP_L = 3, HIP_R = 4, CUFF_L = 5;
  const gap = (c: ControlPair[], a: number, b: number) => Math.hypot(c[b].to.x - c[a].to.x, c[b].to.y - c[a].to.y);

  it('sets the shoulder seam to the shoulder span times the fit', () => {
    expect(gap(garmentControls(shape, body, 1.2, image), SHOULDER_L, SHOULDER_R)).toBeCloseTo(span * 1.2);
  });

  it('widens the garment past the shoulder joints', () => {
    const controls = garmentControls(shape, body, 1.2, image);
    expect(controls[SHOULDER_L].to.x).toBeLessThan(body.shoulderLeft.x);
    expect(controls[SHOULDER_R].to.x).toBeGreaterThan(body.shoulderRight.x);
  });

  it('keeps the garment proportions instead of stretching to the hips', () => {
    const controls = garmentControls(shape, body, 1.2, image);
    const sourceRatio = ((shape.hipY - shape.shoulderY) * image.height) / (shape.shoulderHalf * 2 * image.width);
    const shoulderMid = { x: 200, y: 100 };
    const hipMid = { x: (controls[HIP_L].to.x + controls[HIP_R].to.x) / 2, y: (controls[HIP_L].to.y + controls[HIP_R].to.y) / 2 };
    const drawnRatio = Math.hypot(hipMid.x - shoulderMid.x, hipMid.y - shoulderMid.y) / gap(controls, SHOULDER_L, SHOULDER_R);
    expect(drawnRatio).toBeCloseTo(sourceRatio, 5);
  });

  it('takes only the lean from the body, not the torso length', () => {
    const longer = { ...body, hipLeft: { x: 110, y: 900 }, hipRight: { x: 290, y: 900 } };
    const a = garmentControls(shape, body, 1.2, image);
    const b = garmentControls(shape, longer, 1.2, image);
    expect(b[HIP_L].to.y).toBeCloseTo(a[HIP_L].to.y);
  });

  it('leans the garment when the hips sit off to one side', () => {
    const leaning = { ...body, hipLeft: { x: 260, y: 400 }, hipRight: { x: 440, y: 400 } };
    const controls = garmentControls(shape, leaning, 1.2, image);
    expect(controls[HIP_L].to.x).toBeGreaterThan(garmentControls(shape, body, 1.2, image)[HIP_L].to.x);
  });

  it('pins the collar just above the shoulder line, near the neck', () => {
    const controls = garmentControls(shape, body, 1.2, image);
    const rise = body.shoulderLeft.y - controls[NECK].to.y;
    expect(rise).toBeGreaterThan(0);
    expect(rise).toBeLessThan(gap(controls, SHOULDER_L, SHOULDER_R) * 0.2);
  });

  it('sends the cuffs down the arms', () => {
    const controls = garmentControls(shape, body, 1.2, image);
    expect(controls).toHaveLength(7);
    const cuff = controls[CUFF_L].to;
    expect(cuff.x).toBeLessThan(body.shoulderLeft.x);
    expect(cuff.y).toBeGreaterThan(body.shoulderLeft.y);
  });

  it('leaves out cuffs when the garment has no spread sleeves', () => {
    expect(garmentControls({ ...shape, sleeves: null }, body, 1.2, image)).toHaveLength(5);
  });

  it('skips an arm the pose did not report', () => {
    expect(garmentControls(shape, { ...body, armLeft: null }, 1.2, image)).toHaveLength(6);
  });
});
