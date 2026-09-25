// Moving Least Squares similarity deformation (Schaefer, McPhail, Warren 2006).

export interface Vec {
  x: number;
  y: number;
}

export interface ControlPair {
  from: Vec;
  to: Vec;
}

const EPSILON = 1e-9;

/**
 * Builds a deformation from control pairs. Every point gets its own best-fit rotation and
 * uniform scale, weighted by inverse square distance, so the surface bends smoothly between
 * controls instead of moving as one rigid block.
 */
export function mlsSimilarity(controls: readonly ControlPair[]): (p: Vec) => Vec {
  if (controls.length === 0) return (p) => ({ ...p });
  if (controls.length === 1) {
    const dx = controls[0].to.x - controls[0].from.x;
    const dy = controls[0].to.y - controls[0].from.y;
    return (p) => ({ x: p.x + dx, y: p.y + dy });
  }

  const weights = new Float64Array(controls.length);

  return (v) => {
    let wSum = 0;
    let pxSum = 0;
    let pySum = 0;
    let qxSum = 0;
    let qySum = 0;
    for (let i = 0; i < controls.length; i++) {
      const { from, to } = controls[i];
      const dx = v.x - from.x;
      const dy = v.y - from.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < EPSILON) return { ...to };
      const w = 1 / d2;
      weights[i] = w;
      wSum += w;
      pxSum += w * from.x;
      pySum += w * from.y;
      qxSum += w * to.x;
      qySum += w * to.y;
    }

    const px = pxSum / wSum;
    const py = pySum / wSum;
    const qx = qxSum / wSum;
    const qy = qySum / wSum;

    // Weighted similarity fit, written with complex numbers: c = sum(w * conj(p) * q) / sum(w * |p|^2).
    let cRe = 0;
    let cIm = 0;
    let norm = 0;
    for (let i = 0; i < controls.length; i++) {
      const w = weights[i];
      const ax = controls[i].from.x - px;
      const ay = controls[i].from.y - py;
      const bx = controls[i].to.x - qx;
      const by = controls[i].to.y - qy;
      cRe += w * (ax * bx + ay * by);
      cIm += w * (ax * by - ay * bx);
      norm += w * (ax * ax + ay * ay);
    }

    const vx = v.x - px;
    const vy = v.y - py;
    if (norm < EPSILON) return { x: qx + vx, y: qy + vy };
    cRe /= norm;
    cIm /= norm;
    return { x: qx + cRe * vx - cIm * vy, y: qy + cIm * vx + cRe * vy };
  };
}
