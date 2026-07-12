// Minimal column-major 4x4 matrix / point-transform helpers. Self-contained
// (no external math library) — plugin assets must be self-hosted, and this
// renderer's needs (perspective, lookAt, translate+scale, point projection)
// are small enough not to justify a dependency.
//
// Column-major storage throughout, matching WebGL's uniformMatrix4fv
// convention: mat[col * 4 + row].

export function identity() {
    return new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
    ]);
}

// out = a * b — applying `out` to a vector equals applying b first, then a
// (out * v == a * (b * v)), i.e. the standard "view * model" composition
// order used throughout scene.js.
export function multiply(a, b) {
    const out = new Float32Array(16);
    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) {
                sum += a[k * 4 + row] * b[col * 4 + k];
            }
            out[col * 4 + row] = sum;
        }
    }
    return out;
}

export function perspective(fovYRadians, aspect, near, far) {
    const f = 1.0 / Math.tan(fovYRadians / 2);
    const nf = 1 / (near - far);
    const out = new Float32Array(16);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) * nf;
    out[11] = -1;
    out[14] = 2 * far * near * nf;
    return out;
}

export function lookAt(eye, center, up) {
    const [ex, ey, ez] = eye;
    let zx = ex - center[0], zy = ey - center[1], zz = ez - center[2];
    let len = Math.hypot(zx, zy, zz) || 1;
    zx /= len; zy /= len; zz /= len;

    let xx = up[1] * zz - up[2] * zy;
    let xy = up[2] * zx - up[0] * zz;
    let xz = up[0] * zy - up[1] * zx;
    len = Math.hypot(xx, xy, xz) || 1;
    xx /= len; xy /= len; xz /= len;

    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;

    const out = new Float32Array(16);
    out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
    out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
    out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
    out[12] = -(xx * ex + xy * ey + xz * ez);
    out[13] = -(yx * ex + yy * ey + yz * ez);
    out[14] = -(zx * ex + zy * ey + zz * ez);
    out[15] = 1;
    return out;
}

// Combined translate(t) * scale(s) — no rotation. Sufficient for this
// renderer: every mesh (floor, chord blocks) is an axis-aligned box.
export function translationScale(tx, ty, tz, sx, sy, sz) {
    const out = new Float32Array(16);
    out[0] = sx; out[5] = sy; out[10] = sz; out[15] = 1;
    out[12] = tx; out[13] = ty; out[14] = tz;
    return out;
}

// Returns clip-space [x, y, z, w] = mat * [x, y, z, 1].
export function transformPoint(mat, x, y, z) {
    const w = mat[3] * x + mat[7] * y + mat[11] * z + mat[15];
    const cx = mat[0] * x + mat[4] * y + mat[8] * z + mat[12];
    const cy = mat[1] * x + mat[5] * y + mat[9] * z + mat[13];
    const cz = mat[2] * x + mat[6] * y + mat[10] * z + mat[14];
    return [cx, cy, cz, w];
}
