// Owns all raw WebGL2 state for the highway scene: shaders, the shared box
// mesh, camera matrices, and draw calls.
//
// Lighting model: single fixed directional light + ambient fill, Lambertian
// diffuse (N·L), computed from REAL per-face normals — replaces the earlier
// baked-per-face-shade-constant approach (a flat "top brighter than sides"
// look with no actual light source). Still no specular/shadows/textures;
// this is a deliberate scope cut, not an oversight — a single diffuse term
// already reads as legitimately 3D (faces respond consistently to a light
// direction rather than having independently-tuned brightness values) and
// is cheap (no shadow maps, no per-fragment branching).
//
// Kept separate from main.js so main.js stays focused on the setRenderer
// lifecycle + confidence/number-computation orchestration, and this module
// stays focused on "how do we draw a lit box in the right place."

import { perspective, lookAt, multiply, translationScale, transformPoint } from './gl-math.js';

const VERTEX_SRC = `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
uniform mat4 uMVP;
// Every model matrix here is translate+scale only (no rotation — see
// translationScale in gl-math.js), so the correct normal transform under
// non-uniform scale (the floor is squashed to sy=0.05, blocks are
// non-cubic) reduces to component-wise reciprocal-of-scale rather than a
// full inverse-transpose matrix: for a diagonal scale matrix S, (S^-1)^T
// is just diag(1/sx, 1/sy, 1/sz). Simpler and cheaper than computing a
// general normal matrix, and exact for this renderer's box-only geometry.
uniform vec3 uNormalScale;
out vec3 vNormal;
void main() {
    vNormal = normalize(aNormal * uNormalScale);
    gl_Position = uMVP * vec4(aPosition, 1.0);
}`;

const FRAGMENT_SRC = `#version 300 es
precision mediump float;
in vec3 vNormal;
uniform vec4 uColor;
uniform vec3 uLightDir;   // normalized, points FROM the surface TOWARD the light
uniform float uAmbient;   // fill light so unlit faces aren't pure black
out vec4 outColor;
void main() {
    float diffuse = max(dot(normalize(vNormal), uLightDir), 0.0);
    float shade = uAmbient + (1.0 - uAmbient) * diffuse;
    outColor = vec4(uColor.rgb * shade, uColor.a);
}`;

function compileShader(gl, type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`nns_highway: shader compile failed: ${info}`);
    }
    return shader;
}

function linkProgram(gl, vsSrc, fsSrc) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    // Shaders are refcounted by the program once linked; safe to delete our
    // handles immediately either way.
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const info = gl.getProgramInfoLog(program);
        gl.deleteProgram(program);
        throw new Error(`nns_highway: program link failed: ${info}`);
    }
    return program;
}

// Unit box: x/z in [-0.5, 0.5], y in [0, 1] — grows UP from its local
// origin rather than being centered, so translationScale(tx,ty,tz,...) can
// place the box's BASE at world y=ty directly (floor and chord blocks both
// want "sit on top of this y plane," not "centered on this y plane"). Each
// face carries its own flat (non-interpolated-across-faces) normal.
function buildBoxGeometry() {
    const faces = [
        { normal: [0, 1, 0], verts: [ // top
            [-0.5, 1, -0.5], [0.5, 1, -0.5], [0.5, 1, 0.5],
            [-0.5, 1, -0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5],
        ] },
        { normal: [0, -1, 0], verts: [ // bottom — never actually visible from the camera; kept so the mesh is watertight
            [-0.5, 0, -0.5], [0.5, 0, 0.5], [0.5, 0, -0.5],
            [-0.5, 0, -0.5], [-0.5, 0, 0.5], [0.5, 0, 0.5],
        ] },
        { normal: [0, 0, 1], verts: [ // +z face (toward camera)
            [-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0.5],
            [-0.5, 0, 0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5],
        ] },
        { normal: [0, 0, -1], verts: [ // -z face (away from camera)
            [0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 1, -0.5],
            [0.5, 0, -0.5], [-0.5, 1, -0.5], [0.5, 1, -0.5],
        ] },
        { normal: [1, 0, 0], verts: [ // +x face
            [0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, 1, -0.5],
            [0.5, 0, 0.5], [0.5, 1, -0.5], [0.5, 1, 0.5],
        ] },
        { normal: [-1, 0, 0], verts: [ // -x face
            [-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 1, 0.5],
            [-0.5, 0, -0.5], [-0.5, 1, 0.5], [-0.5, 1, -0.5],
        ] },
    ];
    const data = [];
    for (const face of faces) {
        for (const [x, y, z] of face.verts) data.push(x, y, z, ...face.normal);
    }
    return new Float32Array(data);
}

const BOX_VERTEX_COUNT = 36;
const BOX_STRIDE = 6 * Float32Array.BYTES_PER_ELEMENT;

// Light direction: mostly overhead with a slight forward tilt (toward the
// camera/player, +z-ish) so vertical faces facing the player pick up some
// definition instead of being lit edge-on. Points FROM a surface TOWARD
// the light, already normalized.
const LIGHT_DIR = (() => {
    const v = [0.35, 0.85, 0.4];
    const len = Math.hypot(...v);
    return v.map((c) => c / len);
})();
const AMBIENT = 0.35;

export class Scene {
    constructor() {
        this.gl = null;
        this.program = null;
        this.boxBuffer = null;
        this.boxVao = null;
        this.uMVPLoc = null;
        this.uColorLoc = null;
        this.uNormalScaleLoc = null;
        this.uLightDirLoc = null;
        this.uAmbientLoc = null;
        this.viewMatrix = null;
        this.projMatrix = null;
        this.viewProj = null;
    }

    // Must be called with a FRESH gl context whenever the highway canvas is
    // replaced (see CLAUDE.md's canvas context-type swapping): a new
    // <canvas> means a new WebGL2 context, so every GL object bound to the
    // old one (program, buffers, VAO) is gone — main.js creates a brand new
    // Scene instance in that case rather than trying to rebind this one.
    init(gl, aspect) {
        this.gl = gl;
        this.program = linkProgram(gl, VERTEX_SRC, FRAGMENT_SRC);
        this.uMVPLoc = gl.getUniformLocation(this.program, 'uMVP');
        this.uColorLoc = gl.getUniformLocation(this.program, 'uColor');
        this.uNormalScaleLoc = gl.getUniformLocation(this.program, 'uNormalScale');
        this.uLightDirLoc = gl.getUniformLocation(this.program, 'uLightDir');
        this.uAmbientLoc = gl.getUniformLocation(this.program, 'uAmbient');

        this.boxVao = gl.createVertexArray();
        gl.bindVertexArray(this.boxVao);
        this.boxBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.boxBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, buildBoxGeometry(), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, BOX_STRIDE, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, BOX_STRIDE, 3 * Float32Array.BYTES_PER_ELEMENT);
        gl.bindVertexArray(null);

        // Fixed camera: above and behind the hit line (z=0), looking down
        // the lane toward -z, where approaching chords live. See main.js's
        // HIGHWAY constants for the lane-space time->z convention.
        this.viewMatrix = lookAt([0, 3.2, 6.0], [0, 0.6, -18], [0, 1, 0]);
        this.setAspect(aspect || 1);

        // Light/ambient uniforms don't vary per-box or per-frame — set once
        // here rather than every drawBox() call.
        gl.useProgram(this.program);
        gl.uniform3fv(this.uLightDirLoc, LIGHT_DIR);
        gl.uniform1f(this.uAmbientLoc, AMBIENT);

        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    setAspect(aspect) {
        this.projMatrix = perspective(Math.PI / 4, aspect, 0.1, 100);
        this.viewProj = multiply(this.projMatrix, this.viewMatrix);
    }

    destroy() {
        const gl = this.gl;
        if (!gl) return;
        if (this.program) gl.deleteProgram(this.program);
        if (this.boxBuffer) gl.deleteBuffer(this.boxBuffer);
        if (this.boxVao) gl.deleteVertexArray(this.boxVao);
        this.gl = null;
        this.program = null;
        this.boxBuffer = null;
        this.boxVao = null;
    }

    clear(width, height) {
        const gl = this.gl;
        gl.viewport(0, 0, width, height);
        gl.clearColor(0.04, 0.045, 0.07, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }

    // tx/ty/tz = world position of the box's BASE (bottom-center);
    // sx/sy/sz = box dimensions in world units; color = [r,g,b,a] 0..1.
    drawBox(tx, ty, tz, sx, sy, sz, color) {
        const gl = this.gl;
        const model = translationScale(tx, ty, tz, sx, sy, sz);
        const mvp = multiply(this.viewProj, model);
        gl.useProgram(this.program);
        gl.bindVertexArray(this.boxVao);
        gl.uniformMatrix4fv(this.uMVPLoc, false, mvp);
        gl.uniform3fv(this.uNormalScaleLoc, [1 / sx, 1 / sy, 1 / sz]);
        gl.uniform4fv(this.uColorLoc, color);
        gl.drawArrays(gl.TRIANGLES, 0, BOX_VERTEX_COUNT);
        gl.bindVertexArray(null);
    }

    // Projects a world point to canvas pixel coordinates using the CURRENT
    // view-projection matrix. This is what keeps the 2D overlay glyphs
    // pinned to their matching 3D block instead of drifting independently:
    // main.js computes each visible chord's world z once per frame and
    // feeds the SAME (x, y, z) into both drawBox() and this method, so the
    // glyph and the block it labels always agree on where "here" is.
    // Returns null when the point is behind the camera (cw <= 0) — callers
    // should skip drawing rather than plot a garbage position.
    worldToScreen(x, y, z, canvasWidth, canvasHeight) {
        const [cx, cy, , cw] = transformPoint(this.viewProj, x, y, z);
        if (cw <= 0.0001) return null;
        const ndcX = cx / cw;
        const ndcY = cy / cw;
        return {
            x: (ndcX * 0.5 + 0.5) * canvasWidth,
            y: (1 - (ndcY * 0.5 + 0.5)) * canvasHeight,
        };
    }
}
