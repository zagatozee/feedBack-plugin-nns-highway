// GENERATED FILE — do not edit directly.
// Built from src/*.js by build-screen.mjs (dev-time only, not run by
// feedBack). Edit the files under src/, then run:  node build-screen.mjs
(function () {
    'use strict';
    // ── src/gl-math.js ──────────────────────────────────────────────
    // Minimal column-major 4x4 matrix / point-transform helpers. Self-contained
    // (no external math library) — plugin assets must be self-hosted, and this
    // renderer's needs (perspective, lookAt, translate+scale, point projection)
    // are small enough not to justify a dependency.
    //
    // Column-major storage throughout, matching WebGL's uniformMatrix4fv
    // convention: mat[col * 4 + row].

    function identity() {
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
    function multiply(a, b) {
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

    function perspective(fovYRadians, aspect, near, far) {
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

    function lookAt(eye, center, up) {
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
    function translationScale(tx, ty, tz, sx, sy, sz) {
        const out = new Float32Array(16);
        out[0] = sx; out[5] = sy; out[10] = sz; out[15] = 1;
        out[12] = tx; out[13] = ty; out[14] = tz;
        return out;
    }

    // Returns clip-space [x, y, z, w] = mat * [x, y, z, 1].
    function transformPoint(mat, x, y, z) {
        const w = mat[3] * x + mat[7] * y + mat[11] * z + mat[15];
        const cx = mat[0] * x + mat[4] * y + mat[8] * z + mat[12];
        const cy = mat[1] * x + mat[5] * y + mat[9] * z + mat[13];
        const cz = mat[2] * x + mat[6] * y + mat[10] * z + mat[14];
        return [cx, cy, cz, w];
    }


    // ── src/scene.js ────────────────────────────────────────────────
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

    class Scene {
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

        // Restricts subsequent drawBox() calls to a sub-rectangle of the canvas
        // (buffer pixel coordinates, origin bottom-left per WebGL convention —
        // callers pass a top-left-origin rect and this flips it). Used by the
        // highway width/offset settings to letterbox/pillarbox the 3D scene
        // into a narrower or shifted column without touching the full-canvas
        // clear() above, so the area outside the column stays the same
        // background color rather than a visibly different fill. Must be
        // called once per frame after clear(), before any drawBox() calls —
        // clear() always resets the viewport to the full canvas first.
        setDrawViewport(x, yTop, width, height, canvasHeight) {
            this.gl.viewport(x, canvasHeight - yTop - height, width, height);
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
        //
        // viewportRect (buffer pixels, top-left origin, {x,y,width,height})
        // must match whatever setDrawViewport() the matching drawBox() call
        // used that frame (defaults to the full canvas) — otherwise glyphs
        // drift away from their blocks whenever the highway width/offset
        // settings shrink or shift the 3D content to less than the full
        // canvas.
        worldToScreen(x, y, z, canvasWidth, canvasHeight, viewportRect) {
            const [cx, cy, , cw] = transformPoint(this.viewProj, x, y, z);
            if (cw <= 0.0001) return null;
            const ndcX = cx / cw;
            const ndcY = cy / cw;
            const vp = viewportRect || { x: 0, y: 0, width: canvasWidth, height: canvasHeight };
            return {
                x: vp.x + (ndcX * 0.5 + 0.5) * vp.width,
                y: vp.y + (1 - (ndcY * 0.5 + 0.5)) * vp.height,
            };
        }
    }


    // ── src/nashville.js ────────────────────────────────────────────
    // Port of nns-sample-data/extract_nashville_numbers.py — the verified,
    // batch-tested (500-song working dataset, 0 crashes, 0.86% needs_review)
    // Python extractor. Ported rather than re-derived per the project decision:
    // prefer pre-computed data when available, fall back to this logic computed
    // once client-side and cached, never recomputed per frame.
    //
    // Kept as a direct 1:1 port (same function boundaries, same edge-case
    // handling) so behavior stays auditable against the Python reference rather
    // than drifting into a second, independently-debugged implementation.

    const DIATONIC_SCALE = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

    const NOTE_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    const EXPECTED_DISTANCE = [0, 2, 4, 5, 7, 9, 11];

    // Verse-vote treats "head" (jazz/instrumental lead-sheet term for the
    // opening theme statement) as structurally equivalent to "verse" — see
    // extract_nashville_numbers.py::VERSE_EQUIVALENT_NAMES. Fixed a ~9.6% no-
    // verse-tag fallback rate in the batch-tested dataset.
    const VERSE_EQUIVALENT_NAMES = new Set(['verse', 'head']);

    function parseChordSymbol(symbol) {
        symbol = (symbol || '').trim();
        if (!symbol) return { root: '', quality: '' };
        const m = /^([A-G])([#b]?)(.*)$/.exec(symbol);
        if (!m) return { root: symbol, quality: '' };
        let root = m[1];
        const accidental = m[2];
        let quality = m[3];
        if (accidental) root = root + accidental;
        quality = quality || 'maj';
        return { root, quality };
    }

    function noteToSemitone(note) {
        const { root } = parseChordSymbol(note);
        if (!root) return null;
        const noteName = root[0];
        const accidental = root.slice(1);
        let semitone = NOTE_SEMITONES[noteName];
        if (semitone === undefined) return null;
        if (accidental === '#') semitone = (semitone + 1) % 12;
        else if (accidental === 'b') semitone = (semitone - 1 + 12) % 12;
        return semitone;
    }

    // Resolves a chord_templates[chord.id] entry (as delivered by the highway
    // WS bundle — {name, displayName, fingers, frets, ...}) to a plain chord
    // symbol string ("G", "C#m7", ...), or '' when the template carries no
    // real chord name (fret-shape-only templates, e.g. Lead-arrangement
    // double-stops named "XXXX87_XXXX21" — observed live, confirmed these
    // correctly fail the regex below and fall through to needs-review).
    // Mirrors extract_nashville_numbers.py::resolve_chord_symbol_from_template,
    // simplified because the bundle already hands us the matched template
    // object directly (no refId → chordTemplate map lookup needed — that was
    // an XML-parsing step the WS layer already did for us).
    function resolveChordSymbolFromTemplate(template) {
        if (!template) return '';
        const candidates = [template.name, template.displayName];
        for (const candidate of candidates) {
            if (!candidate) continue;
            const prefix = candidate.split('_', 1)[0].trim();
            if (prefix && /^[A-G][#b]?([A-Za-z0-9()+-]+)?$/.test(prefix)) {
                return prefix;
            }
        }
        return '';
    }

    function chordToNashvilleNumber(chordSymbol, key) {
        const { root, quality } = parseChordSymbol(chordSymbol);
        if (!root) return '?';
        const rootLetter = root[0];
        const keyLetter = key ? key[0] : 'C';
        const rootIndex = DIATONIC_SCALE.indexOf(rootLetter);
        const keyIndex = DIATONIC_SCALE.indexOf(keyLetter);
        const rootSemitone = noteToSemitone(root);
        const keySemitone = noteToSemitone(key);
        if (rootIndex === -1 || keyIndex === -1 || rootSemitone === null || keySemitone === null) {
            return quality ? `${root}${quality}` : root;
        }
        const degree = (((rootIndex - keyIndex) % 7) + 7) % 7 + 1;
        // Expected interval (semitones above tonic) for this scale degree in a
        // plain major scale — relative-to-relative comparison. See
        // extract_nashville_numbers.py's comment on the original bug here: an
        // earlier version compared this against an absolute pitch class and
        // the accidental almost never matched, silently dropping b/# on every
        // non-diatonic chord. Both sides must be relative to the tonic.
        const expected = EXPECTED_DISTANCE[degree - 1];
        const distance = ((rootSemitone - keySemitone) % 12 + 12) % 12;
        let modifier = '';
        if (distance === expected) modifier = '';
        else if (distance === ((expected - 1 + 12) % 12)) modifier = 'b';
        else if (distance === ((expected + 1) % 12)) modifier = '#';
        else if (distance === ((expected - 2 + 12) % 12)) modifier = 'bb';
        else if (distance === ((expected + 2) % 12)) modifier = '##';
        return `${modifier}${degree}`;
    }

    // timedChords must be pre-sorted by .time ascending. Linear scan mirrors
    // extract_nashville_numbers.py::_chord_at_or_after — fine at chart scale
    // (hundreds of chords), called once per verse/head section marker during
    // the once-per-song build step, never per frame.
    function chordAtOrAfter(timedChords, targetTime) {
        for (const c of timedChords) {
            if (c.time >= targetTime - 0.001) return c;
        }
        return null;
    }

    // chordEvents: [{symbol, time}] (symbol may be '' / null — filtered out).
    // sections: [{name, time}] | null — see project brief: the WS bundle's
    // `sections` is song-level only (sourced from a single arrangement file,
    // not necessarily the one `chordEvents` came from). Callers should prefer
    // arrangement-accurate sections from the backend route (routes.py) over
    // bundle.sections when available; pass whichever was resolved here.
    //
    // Returns null (no chords at all) or
    // { key, method: 'verse-vote' | 'frequency-fallback', topVotes, totalVotes }
    // topVotes/totalVotes are null for the frequency-fallback method.
    function detectKey(chordEvents, sections) {
        const timed = chordEvents
            .filter((c) => c.symbol && c.time !== null && c.time !== undefined)
            .slice()
            .sort((a, b) => a.time - b.time);
        if (timed.length === 0) return null;

        if (sections && sections.length) {
            const verseStarts = sections
                .filter((s) => VERSE_EQUIVALENT_NAMES.has((s.name || '').toLowerCase()))
                .map((s) => s.time);
            if (verseStarts.length) {
                const votes = new Map();
                for (const startTime of verseStarts) {
                    const chord = chordAtOrAfter(timed, startTime);
                    if (chord) {
                        const root = parseChordSymbol(chord.symbol).root;
                        votes.set(root, (votes.get(root) || 0) + 1);
                    }
                }
                if (votes.size) {
                    const sorted = [...votes.entries()].sort((a, b) => b[1] - a[1]);
                    const [topRoot, topCount] = sorted[0];
                    return { key: topRoot, method: 'verse-vote', topVotes: topCount, totalVotes: verseStarts.length };
                }
            }
        }

        // Fallback: song-wide most-played root. Strictly worse than the verse
        // vote (see extract_nashville_numbers.py's comment on why "most
        // frequent chord overall" isn't safe on its own — vamping I-bVII riffs,
        // minor-key verses that lean on the relative major) but better than
        // trusting a single first chord that might be an intro pickup.
        const rootCounts = new Map();
        for (const c of timed) {
            const root = parseChordSymbol(c.symbol).root;
            rootCounts.set(root, (rootCounts.get(root) || 0) + 1);
        }
        if (!rootCounts.size) return null;
        const sorted = [...rootCounts.entries()].sort((a, b) => b[1] - a[1]);
        const [topRoot] = sorted[0];
        return { key: topRoot, method: 'frequency-fallback', topVotes: null, totalVotes: null };
    }

    // Two-tier confidence design (see project brief). 'sectionsAreAccurate'
    // must be true only when the sections passed into detectKey() are known to
    // come from the SAME arrangement as chordEvents (i.e. resolved via the
    // backend route, not the WS bundle's song-level `sections`) — otherwise a
    // verse-vote "unanimous" result can still be wrong, as confirmed live
    // (Brown Eyed Girl: bundle.sections sourced from the Bass arrangement gave
    // key=C against the HumStrum chord timeline; the HumStrum arrangement's own
    // sections, read directly, agree with the verified Python extractor's G).
    function classifyConfidence(keyResult, sectionsAreAccurate) {
        if (!keyResult) return 'uncertain';
        if (keyResult.method === 'frequency-fallback') return 'uncertain';
        if (!sectionsAreAccurate) return 'uncertain';
        if (keyResult.totalVotes && keyResult.topVotes / keyResult.totalVotes >= 0.66) return 'confident';
        return 'uncertain';
    }

    // A pre-computed sidecar file (see routes.py) is keyed purely by chord
    // TIME — extract_nashville_numbers.py's schema carries no chord/template
    // id, since it's derived straight from XML in document order. To use one
    // safely we need to be sure it actually corresponds to the CURRENT
    // arrangement's chord list, not a stale file left over from an edited
    // chart or a mismatched arrangement — so this checks both that the chord
    // COUNT matches (chords added/removed since the sidecar was generated)
    // and that every chord's time lines up within a small tolerance (floating-
    // point round-tripping: the WS wire format rounds chord.t to 3 decimals —
    // see lib/song.py::chord_to_wire — while the offline extractor reads the
    // XML's raw, unrounded attribute value, so exact equality would spuriously
    // reject a perfectly valid file over sub-millisecond drift).
    //
    // chordEvents: [{id, time, symbol}] in the SAME order as bundle.chords
    // (i.e. buildChordEvents()'s output). sidecarChords: the sidecar JSON's
    // `chords` array, same shape extract_song_data() emits.
    //
    // Returns an array of nashville_number strings (or null for needs-review
    // entries), aligned index-for-index with chordEvents — or null if the
    // sidecar doesn't safely match and should be treated as unavailable/stale.
    const SIDECAR_TIME_TOLERANCE = 0.01; // seconds

    function matchSidecarToChordEvents(sidecarChords, chordEvents) {
        if (!Array.isArray(sidecarChords) || sidecarChords.length !== chordEvents.length) return null;
        const numbers = new Array(chordEvents.length);
        for (let i = 0; i < chordEvents.length; i++) {
            const sc = sidecarChords[i];
            if (!sc || typeof sc.time !== 'number') return null;
            if (Math.abs(sc.time - chordEvents[i].time) > SIDECAR_TIME_TOLERANCE) return null;
            numbers[i] = sc.nashville_number != null ? sc.nashville_number : null;
        }
        return numbers;
    }


    // ── src/sections-api.js ─────────────────────────────────────────
    // Talks to routes.py's backend route, which reads the SPECIFIC arrangement's
    // own section markers directly from disk (arrangement XML for loose-folder
    // songs, arrangements/<id>.json for sloppak) — see the project brief for why
    // this can't be done from the WS bundle alone: `bundle.sections` is
    // song-level only, sourced from a single arrangement file chosen by core
    // during load (first XML alphabetically / first manifest entry), not
    // necessarily the one the player currently has selected.

    const PLUGIN_ID = 'nns_highway';

    // Returns [{name, time}] on success, or null on any failure (network error,
    // 404, unrecognized format, arrangement has no section data at all) — the
    // caller's contract is: null means "fall back to bundle.sections and mark
    // the result uncertain," never a thrown error the render loop has to guard.
    async function fetchAccurateSections(filename, arrangementIndex) {
        try {
            const url = `/api/plugins/${PLUGIN_ID}/sections/${encodeURIComponent(filename)}?arrangement=${encodeURIComponent(arrangementIndex)}`;
            const res = await fetch(url);
            if (!res.ok) return null;
            const data = await res.json();
            if (!data || !Array.isArray(data.sections)) return null;
            return data.sections;
        } catch (e) {
            return null;
        }
    }


    // ── src/nashville-file-api.js ───────────────────────────────────
    // Talks to routes.py's pre-computed-sidecar endpoints. The sidecar file
    // itself lives next to the song's own chart data (see routes.py's module
    // docstring for the exact on-disk layout / hard write constraints) — this
    // module only knows the HTTP surface.

    // Named distinctly from sections-api.js's own PLUGIN_ID constant (same
    // value) — both files get concatenated into one shared scope by
    // build-screen.mjs for the classic (non-ES-module) deployed screen.js, so a
    // same-named `const` in two source files would collide there even though
    // each is a separate module scope here.
    const NASHVILLE_FILE_PLUGIN_ID = 'nns_highway';

    // Returns { available: true, data } | { available: false } | null (network
    // failure). Callers treat both `available: false` and `null` identically —
    // "no usable pre-computed file" — the distinction only matters for logging.
    async function fetchPrecomputed(filename, arrangementIndex) {
        try {
            const url = `/api/plugins/${NASHVILLE_FILE_PLUGIN_ID}/nashville/${encodeURIComponent(filename)}?arrangement=${encodeURIComponent(arrangementIndex)}`;
            const res = await fetch(url);
            if (!res.ok) return null;
            return await res.json();
        } catch (e) {
            return null;
        }
    }

    // payload must match extract_nashville_numbers.py's extract_song_data()
    // schema minus section_markers (the backend fills that in itself by
    // re-reading the arrangement's own phrase data — see routes.py — since the
    // frontend has no access to phrase names via the WS bundle).
    // Returns true on confirmed success, false otherwise (never throws) — the
    // caller's contract is "best-effort persistence," not a blocking operation.
    async function savePrecomputed(filename, arrangementIndex, payload) {
        try {
            const url = `/api/plugins/${NASHVILLE_FILE_PLUGIN_ID}/nashville/${encodeURIComponent(filename)}?arrangement=${encodeURIComponent(arrangementIndex)}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            return res.ok;
        } catch (e) {
            return false;
        }
    }


    // ── src/color-scheme.js ─────────────────────────────────────────
    // Chord/number color schemes — swappable by design (see settings.html's
    // nns-color-scheme select). Only one scheme exists today (circle_of_fifths,
    // the default), but every caller goes through getColorScheme(id) rather
    // than importing colorForChord directly, so adding a second scheme later
    // is a matter of adding an entry to COLOR_SCHEMES, not a rewrite.
    //
    // circle_of_fifths is also the STANDING convention for chord/number
    // coloring across projects — the same underlying logic (hue = circle-of-
    // fifths distance from tonic, not raw scale-degree number) is reused for
    // the Pub Stage table layout rather than re-derived there. Keep this file
    // self-contained (no imports) so it stays trivially portable.

    const SEMITONES_PER_OCTAVE = 12;
    const HUE_STEP_DEGREES = 360 / SEMITONES_PER_OCTAVE; // 30

    // Multiplicative inverse of 7 mod 12 is 7 itself (7*7 = 49 = 4*12 + 1) —
    // stepping by a fifth (7 semitones) forward k times lands on semitone
    // offset s = 7k mod 12, so k = 7s mod 12 recovers "how many fifths away"
    // a given semitone offset is, i.e. its position on the circle of fifths.
    const FIFTHS_INVERSE_MOD_12 = 7;

    function circleOfFifthsPosition(semitoneOffsetFromTonic) {
        const s = ((semitoneOffsetFromTonic % SEMITONES_PER_OCTAVE) + SEMITONES_PER_OCTAVE) % SEMITONES_PER_OCTAVE;
        return (s * FIFTHS_INVERSE_MOD_12) % SEMITONES_PER_OCTAVE;
    }

    // Semitone offset from tonic for each plain-major-scale degree (1-indexed
    // degree -> array index degree-1). Matches nashville.js's EXPECTED_DISTANCE.
    const DEGREE_SEMITONES = [0, 2, 4, 5, 7, 9, 11];

    // Parses the exact string format chordToNashvilleNumber() returns
    // ("1", "b7", "#4", "bb6", ...) back into a semitone offset from the
    // tonic, without needing the original chord symbol + key again — this is
    // the representation already threaded through the rest of the plugin
    // (sidecar schema, numbersById map), so reconstructing from it keeps this
    // module decoupled from nashville.js.
    const NASHVILLE_NUMBER_RE = /^(b{0,2}|#{0,2})([1-7])$/;

    // True only for the exact `${modifier}${degree}` shape
    // chordToNashvilleNumber() produces — false for chordToNashvilleNumber()'s
    // other fallback return values (e.g. the raw original symbol string, for
    // templates with no diatonically-resolvable root — fret-shape-only Lead
    // double-stops like "XXXX87_XXXX21"). Callers use this to decide whether a
    // chord is a real scale degree worth coloring at all, vs. a neutral/
    // needs-review case that shouldn't silently look like "the 1 chord" just
    // because it fails to parse.
    function isRealNashvilleNumber(nashvilleNumber) {
        return NASHVILLE_NUMBER_RE.test(nashvilleNumber || '');
    }

    function semitoneFromNashvilleNumber(nashvilleNumber) {
        const m = NASHVILLE_NUMBER_RE.exec(nashvilleNumber || '');
        if (!m) return null;
        const [, modifier, degreeStr] = m;
        const degree = parseInt(degreeStr, 10);
        let semitone = DEGREE_SEMITONES[degree - 1];
        if (modifier === 'b') semitone -= 1;
        else if (modifier === 'bb') semitone -= 2;
        else if (modifier === '#') semitone += 1;
        else if (modifier === '##') semitone += 2;
        return semitone;
    }

    // Fallback hue for '?' / unparseable numbers — arbitrary but stable so the
    // same non-chord glyph always renders the same (desaturated) color rather
    // than flickering between calls.
    const FALLBACK_HUE = 0;

    function hueForNashvilleNumber(nashvilleNumber) {
        const semitone = semitoneFromNashvilleNumber(nashvilleNumber);
        if (semitone === null) return FALLBACK_HUE;
        return circleOfFifthsPosition(semitone) * HUE_STEP_DEGREES;
    }

    // quality: the suffix parseChordSymbol() produces ('', 'maj', 'm', 'm7',
    // 'dim', 'dim7', '7', 'maj7', 'sus4', 'aug', ...). Only minor and
    // diminished chords get the darker/desaturated treatment per the project
    // decision — extensions and other modifiers (7, sus, add9, #/b) stay at
    // the base hue and are distinguished only by the on-block text label, not
    // a separate color.
    function isMinorOrDiminished(quality) {
        const q = (quality || '').toLowerCase();
        if (q.startsWith('maj')) return false; // maj, maj7, maj9... (must be checked before the bare 'm' check below)
        if (q.startsWith('dim')) return true;
        if (q.startsWith('m')) return true; // m, m6, m7, m7b5, m9, mmaj7 — all minor-family
        return false;
    }

    function hslToRgb01(h, s, l) {
        const c = (1 - Math.abs(2 * l - 1)) * s;
        const hp = (((h % 360) + 360) % 360) / 60;
        const x = c * (1 - Math.abs((hp % 2) - 1));
        let r1 = 0, g1 = 0, b1 = 0;
        if (hp < 1) { r1 = c; g1 = x; b1 = 0; }
        else if (hp < 2) { r1 = x; g1 = c; b1 = 0; }
        else if (hp < 3) { r1 = 0; g1 = c; b1 = x; }
        else if (hp < 4) { r1 = 0; g1 = x; b1 = c; }
        else if (hp < 5) { r1 = x; g1 = 0; b1 = c; }
        else { r1 = c; g1 = 0; b1 = x; }
        const m = l - c / 2;
        return [r1 + m, g1 + m, b1 + m];
    }

    const SATURATION = { base: 0.62, minor: 0.40 };
    const LIGHTNESS = { base: 0.52, minor: 0.32 };

    // Returns { hue, saturation, lightness, rgb01: [r,g,b] (0-1, for WebGL),
    // css: 'hsl(...)' (for 2D canvas) }.
    function circleOfFifthsColorForChord(nashvilleNumber, quality) {
        const hue = hueForNashvilleNumber(nashvilleNumber);
        const minor = isMinorOrDiminished(quality);
        const saturation = minor ? SATURATION.minor : SATURATION.base;
        const lightness = minor ? LIGHTNESS.minor : LIGHTNESS.base;
        return {
            hue,
            saturation,
            lightness,
            rgb01: hslToRgb01(hue, saturation, lightness),
            css: `hsl(${hue.toFixed(1)}, ${(saturation * 100).toFixed(0)}%, ${(lightness * 100).toFixed(0)}%)`,
        };
    }

    const COLOR_SCHEMES = {
        circle_of_fifths: {
            id: 'circle_of_fifths',
            label: 'Circle of fifths (default)',
            colorForChord: circleOfFifthsColorForChord,
        },
    };

    const DEFAULT_COLOR_SCHEME_ID = 'circle_of_fifths';

    function getColorScheme(id) {
        return COLOR_SCHEMES[id] || COLOR_SCHEMES[DEFAULT_COLOR_SCHEME_ID];
    }


    // ── src/main.js ─────────────────────────────────────────────────
    // Nashville Numbers Highway — setRenderer factory (feedBack CLAUDE.md
    // "Visualization plugins" contract). Declares contextType: 'webgl2' per the
    // project's realism-leaning rendering goal.
    //
    // Lifecycle + perf rules this file follows (see CLAUDE.md "Performance —
    // never run DOM queries on a per-frame path" and the setRenderer contract):
    //   - DOM/GL resources are resolved once in init() and cached on the
    //     instance; draw() never calls querySelector or creates DOM nodes.
    //   - Per-song work (fetching accurate sections, running key detection,
    //     computing every chord's Nashville number) happens ONCE per song and
    //     is cached; draw() only reads the cache.
    //   - The factory returns a fresh object per call (required for
    //     splitscreen — each panel gets its own instance/cache).
    //   - init() may run again on an instance that was previously destroy()'d
    //     (playSong's stop() -> init() reuse) — every ref is nulled in
    //     destroy() and re-acquired in init().
    //
    // Hybrid pre-computed/live design (project brief, decision 1) — three tiers,
    // checked in order in _buildChordData():
    //   1. Pre-computed sidecar file next to the song's own chart data (see
    //      routes.py) — persistent, shareable, 'confident' tier. Checked first.
    //   2. On-demand generation: live computation, persisted as a new sidecar
    //      file IFF it reaches 'confident' tier AND the user has opted into
    //      autoGenerate (plugin setting, off by default — this writes a file
    //      next to the user's chart, so it's opt-in, not automatic-by-default).
    //   3. Live per-frame... really live-per-song (see cache below) computation
    //      with no persistence — same code path as tier 2, just not saved.


    const AUTO_GENERATE_KEY = 'nns_highway.autoGenerate';
    const COLOR_SCHEME_KEY = 'nns_highway.colorScheme';
    const HIGHWAY_WIDTH_KEY = 'nns_highway.highwayWidthPct';
    const HIGHWAY_OFFSET_KEY = 'nns_highway.highwayOffsetPct';
    const HIGHWAY_WIDTH_DEFAULT_PCT = 100;
    const HIGHWAY_OFFSET_DEFAULT_PCT = 0;

    function isAutoGenerateEnabled() {
        try {
            return window.localStorage.getItem(AUTO_GENERATE_KEY) === 'true';
        } catch (e) {
            return false; // localStorage unavailable (private mode, sandboxed iframe) -> default off
        }
    }

    function getActiveColorScheme() {
        try {
            return getColorScheme(window.localStorage.getItem(COLOR_SCHEME_KEY) || DEFAULT_COLOR_SCHEME_ID);
        } catch (e) {
            return getColorScheme(DEFAULT_COLOR_SCHEME_ID);
        }
    }

    // Highway width (% of canvas) and horizontal offset from center (% of
    // canvas, negative = left) — settings.html's two range sliders. Read only
    // on resize/canvas-replace (see _updateViewportRect), never per-frame, per
    // this file's DOM/localStorage perf rule. Clamped defensively since these
    // come from localStorage, which a user could hand-edit to a garbage value.
    function getActiveLayoutSettings() {
        let widthPct = HIGHWAY_WIDTH_DEFAULT_PCT;
        let offsetPct = HIGHWAY_OFFSET_DEFAULT_PCT;
        try {
            const storedWidth = parseFloat(window.localStorage.getItem(HIGHWAY_WIDTH_KEY));
            if (Number.isFinite(storedWidth)) widthPct = storedWidth;
        } catch (e) { /* localStorage unavailable -> default */ }
        try {
            const storedOffset = parseFloat(window.localStorage.getItem(HIGHWAY_OFFSET_KEY));
            if (Number.isFinite(storedOffset)) offsetPct = storedOffset;
        } catch (e) { /* localStorage unavailable -> default */ }
        widthPct = Math.min(100, Math.max(20, widthPct));
        offsetPct = Math.min(50, Math.max(-50, offsetPct));
        return { widthPct, offsetPct };
    }

    // Standard Nashville Number System notation: a bare number means a plain
    // major triad, so only non-major qualities get a visible suffix (e.g. "6m",
    // "27", "4sus4"). Extensions/modifiers are distinguished this way rather
    // than by color — see color-scheme.js's module doc comment.
    function displayLabel(number, quality) {
        if (number == null) return null;
        if (!quality || quality === 'maj') return number;
        // A middle-dot separator, not bare concatenation — "b3" + quality "5"
        // (a power chord, e.g. root "C5") concatenated directly reads as "b35",
        // indistinguishable from a malformed/invalid Nashville number. The
        // per-chord number/quality lookup itself was already correct; this was
        // purely a display-formatting defect.
        return `${number}·${quality}`;
    }

    // Lane-space conventions shared by the 3D scene and the overlay projection:
    // z=0 is the hit line; chords approach from -z as bundle.currentTime rises
    // toward chord.t. SPEED is world units per second of chart time — purely a
    // visual tuning knob, not derived from anything.
    const HIGHWAY = {
        LANE_WIDTH: 4.0,
        SPEED: 10.0,
        FUTURE_WINDOW: 3.0, // seconds of chart lookahead to keep visible
        // A chord within PAST_WINDOW of currentTime sits close enough to the
        // camera (eye z=6, hit line z=0) to render oversized/near-clipped — see
        // _collectVisibleChords' fadeAlpha, which ramps a chord's opacity to 0
        // exactly as it reaches this boundary so it visually dissolves before
        // it gets close enough to look wrong, rather than popping/clipping.
        PAST_WINDOW: 0.5,   // seconds behind currentTime before a chord is culled
        BLOCK_WIDTH: 3.2,
        BLOCK_HEIGHT: 0.6,
        BLOCK_DEPTH: 1.0,
    };
    HIGHWAY.FLOOR_LENGTH = HIGHWAY.FUTURE_WINDOW * HIGHWAY.SPEED + 10;

    // Flat neutral gray for chords with no resolvable symbol (needs-review) —
    // deliberately NOT run through the color scheme, since hue 0 there means
    // "the 1 chord," and a needs-review block asserting that would be
    // misleading rather than merely unstyled.
    const NEEDS_REVIEW_RGB01 = [0.35, 0.35, 0.38];

    // bundle.songInfo does NOT carry the song's filename — confirmed against a
    // real running instance: the song_info WS message (and therefore
    // bundle.songInfo) only has {title, artist, arrangement, arrangement_index,
    // arrangements, duration, tuning, capo, centOffset, format, audio_url,
    // audio_error, stems, ...}, no filename. That field only exists on the
    // DIFFERENT songInfo shape passed to the (unused, by design) Auto-mode
    // matchesArrangement(songInfo) callback — conflating the two silently sent
    // every backend request in this plugin to "/nashville/undefined" and
    // "/sections/undefined" for an entire session, which 404'd and gracefully
    // (but wrongly, from a UX standpoint) fell back to live/uncertain every
    // time, masking itself as "just an uncertain song" rather than a bug.
    // window.feedBack.currentSong.filename is the real, populated source.
    function getCurrentSongFilename() {
        try {
            return (window.feedBack && window.feedBack.currentSong && window.feedBack.currentSong.filename) || null;
        } catch (e) {
            return null;
        }
    }

    function songCacheKey(filename, arrangementIndex) {
        return `${filename}#${arrangementIndex}`;
    }

    // Binary search for the first index in a time-ascending-sorted array whose
    // `.t` field is >= targetTime. Local implementation — this used to call a
    // bundle.lowerBoundT() helper, which turned out not to exist on the real
    // render bundle at all: confirmed live by capturing the actual bundle
    // object passed to draw(), whose only function-typed properties are
    // {project, fretX, getNoteState, getNoteStateProvider}. Every draw() call
    // threw, and after 3 failed frames in a row feedBack's core silently
    // reverted to the default renderer (a real, documented core behavior —
    // not a plugin crash the user would see directly), which is why chord
    // blocks never appeared at all and standard note gems showed instead.
    function lowerBoundByTime(sortedChords, targetTime) {
        let lo = 0;
        let hi = sortedChords.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (sortedChords[mid].t < targetTime) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    function buildChordEvents(chords, chordTemplates) {
        const events = [];
        for (const c of chords) {
            const template = chordTemplates[c.id];
            const symbol = resolveChordSymbolFromTemplate(template) || null;
            events.push({ id: c.id, time: c.t, symbol });
        }
        return events;
    }

    // Builds the deduplicated legend list for the reference panel — one entry
    // per distinct on-screen label the song actually uses (same granularity as
    // displayLabel(), so "6" and "6m" are listed separately), ordered by
    // circle-of-fifths hue position to match the block coloring rather than by
    // first appearance, so the legend reads like a stable reference the player
    // can scan once rather than a shuffled list.
    function buildUniqueChordList(numbersById, qualityById, scheme) {
        const seen = new Map(); // label -> { label, number, quality, color }
        for (const [id, number] of numbersById) {
            if (!isRealNashvilleNumber(number)) continue; // skip null / non-diatonic fallback strings — not real degrees
            const quality = qualityById.get(id) || null;
            const label = displayLabel(number, quality);
            if (seen.has(label)) continue;
            seen.set(label, { label, number, quality, color: scheme.colorForChord(number, quality) });
        }
        return [...seen.values()].sort((a, b) => {
            if (a.color.hue !== b.color.hue) return a.color.hue - b.color.hue;
            return a.label.localeCompare(b.label);
        });
    }

    function createNnsHighwayRenderer() {
        return {
            contextType: 'webgl2',

            // GL/canvas state
            _canvas: null,
            _gl: null,
            _scene: null,

            // Own 2D overlay canvas for chord-number glyphs + confidence cues +
            // the key HUD label. See CLAUDE.md's overlay-vs-setRenderer note on
            // custom WebGL renderers maintaining their own 2D layer (mirrors the
            // bundled 3D Highway's approach) — raw WebGL2 text rendering (glyph
            // atlases etc.) is a separate, larger effort than this project.
            _overlayCanvas: null,
            _overlayCtx: null,

            _onCanvasReplaced: null,
            _onVisibility: null,

            // Per-song cache. Rebuilt only when songCacheKey() changes.
            //   { songKey, key, confidence, numbersById: Map<chordId, string> }
            _cache: null,
            // songKey currently being (re)built, or null. Guards against
            // kicking off a duplicate async build every frame while the first
            // one is still in flight.
            _building: null,

            // Rightmost canvas-buffer x-coordinate actually visible in the
            // browser viewport — see _updateVisibleRightBound()'s doc comment.
            // Recomputed on resize only (getBoundingClientRect forces layout,
            // so this must never run on the per-frame draw() path), used by
            // _drawReferencePanel to keep the legend from landing off-screen.
            _visibleRightBound: null,

            // Buffer-pixel sub-rectangle {x, y, width, height} (top-left
            // origin) the 3D scene actually renders into, per the highway
            // width/offset settings — see _updateViewportRect(). Defaults to
            // the full canvas. Recomputed on resize/canvas-replace only
            // (localStorage + the width/height it's derived from are both
            // resize-time-only reads, per this file's per-frame perf rule).
            _viewportRect: null,

            init(canvas, bundle) {
                this._canvas = canvas;
                this._cache = null;
                this._building = null;

                this._overlayCanvas = document.createElement('canvas');
                this._overlayCanvas.className = 'nns-highway-overlay';
                this._overlayCanvas.style.position = 'absolute';
                this._overlayCanvas.style.left = '0';
                this._overlayCanvas.style.top = '0';
                this._overlayCanvas.style.pointerEvents = 'none';
                // Without an explicit z-index this stays at stacking level
                // "auto" — confirmed live against feedBack's own player chrome
                // that #highway itself carries an explicit `z-index: 1` (see
                // #player #highway in feedBack's CSS), which per normal CSS
                // stacking order (positive z-index paints after/above z-index
                // auto, regardless of DOM order) puts the WebGL canvas's fully
                // opaque per-pixel buffer (Scene.clear() clears to alpha 1.0
                // every frame, so there is no transparent gap to show through)
                // ON TOP of this 2D overlay everywhere the two overlap. This
                // silently ate the entire overlay (glyphs happened to still be
                // readable only where the WebGL canvas doesn't paint anything
                // opaque at that exact pixel) and made the reference panel
                // fully invisible despite its pixels being correctly present
                // in the overlay's own buffer — confirmed by forcing a high
                // z-index experimentally and watching the panel reappear.
                // 2 is enough to clear #highway's z-index:1 while staying
                // below feedBack's own HUD/transport/popover chrome (all
                // z-index >= 20), so real UI still layers above this overlay.
                this._overlayCanvas.style.zIndex = '2';
                this._overlayCanvas.width = canvas.width;
                this._overlayCanvas.height = canvas.height;
                canvas.parentNode.style.position = canvas.parentNode.style.position || 'relative';
                canvas.parentNode.insertBefore(this._overlayCanvas, canvas.nextSibling);
                this._overlayCtx = this._overlayCanvas.getContext('2d');

                this._updateViewportRect();
                this._initGL(canvas);
                this._updateVisibleRightBound();

                this._onCanvasReplaced = (event) => {
                    const { newCanvas } = event.detail;
                    this._canvas = newCanvas;
                    this._updateViewportRect();
                    // A replaced canvas means a brand new WebGL2 context — every
                    // GL object bound to the old one (program, buffers, VAO) is
                    // gone with it, so this rebuilds the whole Scene rather than
                    // trying to salvage the old instance.
                    this._initGL(newCanvas);
                    // Re-home the overlay next to the new canvas element.
                    newCanvas.parentNode.insertBefore(this._overlayCanvas, newCanvas.nextSibling);
                    this._updateVisibleRightBound();
                };
                window.feedBack.on('highway:canvas-replaced', this._onCanvasReplaced);

                this._onVisibility = (event) => {
                    const { visible } = event.detail;
                    this._overlayCanvas.style.display = visible ? '' : 'none';
                };
                window.feedBack.on('highway:visibility', this._onVisibility);
            },

            // The canvas's CSS box can extend past the actual browser viewport
            // when a persistent sidebar eats into the available width but the
            // canvas itself is still sized to the full window width — confirmed
            // live against feedBack's own always-on desktop nav (#v3-sidebar):
            // canvas.getBoundingClientRect().width equals window.innerWidth
            // regardless of viewport size, with the canvas's left edge offset by
            // the sidebar's width, so its right edge silently overflows past
            // the visible viewport by exactly that much. Anything drawn naively
            // at "canvas width minus a margin" (e.g. the reference panel) can
            // end up entirely off-screen as a result. Resize-time only — never
            // called from draw(), since getBoundingClientRect() forces layout.
            _updateVisibleRightBound() {
                if (!this._canvas || !this._overlayCanvas) return;
                const rect = this._canvas.getBoundingClientRect();
                if (rect.width <= 0) {
                    this._visibleRightBound = this._overlayCanvas.width;
                    return;
                }
                const visibleRightCss = Math.min(rect.right, window.innerWidth) - rect.left;
                const scaleX = this._overlayCanvas.width / rect.width;
                this._visibleRightBound = Math.max(0, visibleRightCss * scaleX);
            },

            // Computes the buffer-pixel sub-rectangle the 3D scene renders
            // into, from settings.html's width/offset sliders (see
            // getActiveLayoutSettings()). width=100/offset=0 (the defaults)
            // yields the full canvas, so this is a no-op for players who never
            // touch those settings. Resize-time only, same reasoning as
            // _updateVisibleRightBound() — never called from draw().
            // canvasWidth/canvasHeight default to this._canvas's own buffer
            // size but can be passed explicitly (resize() receives the new
            // size as arguments; core updates this._canvas's actual width/
            // height attributes around the same time, but this avoids
            // depending on that ordering).
            _updateViewportRect(canvasWidth, canvasHeight) {
                if (!this._canvas) return;
                const { widthPct, offsetPct } = getActiveLayoutSettings();
                canvasWidth = canvasWidth != null ? canvasWidth : this._canvas.width;
                canvasHeight = canvasHeight != null ? canvasHeight : this._canvas.height;
                const width = Math.max(1, Math.round(canvasWidth * widthPct / 100));
                // offsetPct shifts the column's CENTER away from the canvas's
                // own center, e.g. +50% (of canvas width) moves it as far
                // right as it can go while the column's left edge stays
                // on-canvas.
                const centerX = canvasWidth / 2 + (canvasWidth * offsetPct / 100);
                const x = Math.round(Math.min(Math.max(0, centerX - width / 2), canvasWidth - width));
                this._viewportRect = { x, y: 0, width, height: canvasHeight };
            },

            _initGL(canvas) {
                this._gl = canvas.getContext('webgl2');
                this._scene = new Scene();
                // Aspect is derived from the VIEWPORT rect (the width/offset
                // settings' sub-column), not the raw canvas — otherwise a
                // narrowed column would stretch/squash the 3D perspective
                // instead of just showing less of the same undistorted scene.
                const vp = this._viewportRect || { width: canvas.width, height: canvas.height };
                const aspect = vp.height > 0 ? vp.width / vp.height : 1;
                this._scene.init(this._gl, aspect);
            },

            draw(bundle) {
                const filename = getCurrentSongFilename();
                const key = songCacheKey(filename, bundle.songInfo.arrangement_index);
                if ((!this._cache || this._cache.songKey !== key) && this._building !== key) {
                    if (bundle.chords.length === 0) {
                        // No chord data for this arrangement (Bass-only tracks
                        // and some single-note Lead tracks have none) — nothing
                        // to detect or render. Skip the sidecar/live-computation
                        // cascade entirely (there's nothing to fetch or compute)
                        // and record that state so _drawOverlay can show a clear
                        // message instead of silently rendering an empty
                        // highway with no explanation.
                        this._cache = { songKey: key, noChordData: true };
                    } else {
                        this._building = key;
                        this._buildChordData(bundle, key, filename).finally(() => {
                            if (this._building === key) this._building = null;
                        });
                    }
                }

                // Defensive sync, not a resize-event dependency: _drawScene's
                // WebGL viewport is sized from this._canvas.width/height while
                // _drawOverlay's glyph projection is sized from
                // this._overlayCanvas.width/height. resize() normally keeps
                // these equal, but if the main canvas's buffer resolution
                // changes (e.g. an adaptive render-scale update) in a frame
                // where resize() hasn't fired yet, the two draw calls would
                // compute screen positions against DIFFERENT pixel grids —
                // the block and its number glyph would drift apart over time
                // instead of tracking together. Cheap (a property read/write,
                // not a layout-forcing DOM query), so safe to check every
                // frame rather than only on resize.
                if (this._canvas && this._overlayCanvas &&
                    (this._overlayCanvas.width !== this._canvas.width || this._overlayCanvas.height !== this._canvas.height)) {
                    this._overlayCanvas.width = this._canvas.width;
                    this._overlayCanvas.height = this._canvas.height;
                    this._updateViewportRect();
                    if (this._scene) {
                        const vp = this._viewportRect;
                        this._scene.setAspect(vp.height > 0 ? vp.width / vp.height : 1);
                    }
                    this._updateVisibleRightBound();
                }

                const visible = this._collectVisibleChords(bundle);
                this._drawScene(visible);
                this._drawOverlay(visible);
            },

            resize(w, h) {
                if (this._overlayCanvas) {
                    this._overlayCanvas.width = w;
                    this._overlayCanvas.height = h;
                }
                this._updateViewportRect(w, h);
                if (this._scene) {
                    const vp = this._viewportRect || { width: w, height: h };
                    this._scene.setAspect(vp.height > 0 ? vp.width / vp.height : 1);
                }
                this._updateVisibleRightBound();
            },

            destroy() {
                if (this._onCanvasReplaced) window.feedBack.off('highway:canvas-replaced', this._onCanvasReplaced);
                if (this._onVisibility) window.feedBack.off('highway:visibility', this._onVisibility);
                this._onCanvasReplaced = null;
                this._onVisibility = null;

                if (this._overlayCanvas && this._overlayCanvas.parentNode) {
                    this._overlayCanvas.parentNode.removeChild(this._overlayCanvas);
                }
                this._overlayCanvas = null;
                this._overlayCtx = null;

                if (this._scene) this._scene.destroy();
                this._scene = null;

                this._canvas = null;
                this._gl = null;
                this._cache = null;
                this._building = null;
            },

            // ── Per-song build (not per-frame) ──────────────────────────────

            async _buildChordData(bundle, key, filename) {
                const { arrangement_index: arrangementIndex, title } = bundle.songInfo;
                const chordEvents = buildChordEvents(bundle.chords, bundle.chordTemplates);
                // Resolved once per song build, not per frame — draw() reads
                // this._cache.colorScheme rather than touching localStorage on
                // every frame (see CLAUDE.md's per-frame perf rules).
                const colorScheme = getActiveColorScheme();

                // Tier 1: pre-computed sidecar file, checked first (hybrid
                // design, project brief decision 1). Persistent and shareable —
                // produced by either this plugin (tier 2 below) or the offline
                // batch extractor, same JSON schema either way (see routes.py).
                const precomputed = await fetchPrecomputed(filename, arrangementIndex);
                if (this._building !== key) return; // superseded mid-fetch — don't clobber a fresher cache
                if (precomputed && precomputed.available && precomputed.data) {
                    const numbers = matchSidecarToChordEvents(precomputed.data.chords, chordEvents);
                    if (numbers) {
                        // matchSidecarToChordEvents already verified count + time
                        // alignment, so precomputed.data.chords[i] <-> chordEvents[i]
                        // 1:1 — safe to pull quality from the sidecar's own symbol
                        // at the same index rather than re-deriving it.
                        const numbersById = new Map();
                        const qualityById = new Map();
                        chordEvents.forEach((ev, i) => {
                            numbersById.set(ev.id, numbers[i]);
                            const sidecarSymbol = precomputed.data.chords[i] && precomputed.data.chords[i].symbol;
                            qualityById.set(ev.id, sidecarSymbol ? parseChordSymbol(sidecarSymbol).quality : null);
                        });
                        this._cache = {
                            songKey: key,
                            key: precomputed.data.detected_key || null,
                            confidence: 'confident',
                            numbersById,
                            qualityById,
                            colorScheme,
                            uniqueChords: buildUniqueChordList(numbersById, qualityById, colorScheme),
                        };
                        return;
                    }
                    // Sidecar exists but doesn't match this chord list (stale —
                    // edited chart, wrong arrangement) — fall through rather
                    // than trusting it. matchSidecarToChordEvents already
                    // logged nothing here by design (not an error, just a miss);
                    // tier 2/3 below will recompute normally.
                }

                // Tier 2 / tier 3: live computation. Identical either way — the
                // SAVE step at the end is the only thing that distinguishes
                // "on-demand generation" (persisted, gated by the autoGenerate
                // setting) from plain ephemeral live computation.
                const accurateSections = await fetchAccurateSections(filename, arrangementIndex);
                if (this._building !== key) return;
                const sectionsForDetection = accurateSections || bundle.sections;

                const keyResult = detectKey(chordEvents, sectionsForDetection);
                const confidence = classifyConfidence(keyResult, !!accurateSections);
                const resolvedKey = keyResult ? keyResult.key : null;

                const numbersById = new Map();
                const qualityById = new Map();
                for (const ev of chordEvents) {
                    numbersById.set(ev.id, ev.symbol ? chordToNashvilleNumber(ev.symbol, resolvedKey || 'C') : null);
                    qualityById.set(ev.id, ev.symbol ? parseChordSymbol(ev.symbol).quality : null);
                }

                if (this._building !== key) return;
                this._cache = {
                    songKey: key,
                    key: resolvedKey,
                    confidence,
                    numbersById,
                    qualityById,
                    colorScheme,
                    uniqueChords: buildUniqueChordList(numbersById, qualityById, colorScheme),
                };

                // Tier 2: only ever persist a result we're actually confident
                // in — writing an 'uncertain' guess to disk as if it were
                // pre-computed ground truth would be worse than not caching it.
                if (confidence === 'confident' && isAutoGenerateEnabled()) {
                    const payload = {
                        title: title || '',
                        detected_key: resolvedKey,
                        chords: chordEvents.map((ev) => ({
                            symbol: ev.symbol,
                            time: ev.time,
                            nashville_number: numbersById.get(ev.id),
                            needs_review: !ev.symbol,
                        })),
                    };
                    // Fire-and-forget — best-effort persistence, must not block
                    // or delay rendering (this._cache is already set above, so
                    // the live-computed result is already what's being drawn
                    // regardless of how this resolves). savePrecomputed() never
                    // rejects (it catches internally), so no .catch() is needed
                    // — but a failure (permission denied on a read-only mount,
                    // disk full, etc.) should still be visible somewhere, since
                    // the caller here never checks the return value otherwise.
                    savePrecomputed(filename, arrangementIndex, payload).then((ok) => {
                        if (!ok) {
                            console.warn(`[nns_highway] failed to save pre-computed Nashville-number data for "${filename}" (arrangement ${arrangementIndex}) — continuing with this session's live-computed result, unsaved.`);
                        }
                    });
                }
            },

            // ── Per-frame draw ───────────────────────────────────────────────

            // Windowed to the visible time range via a local binary-search
            // helper (see lowerBoundByTime's doc comment) rather than a full
            // array scan, per the project's per-frame perf rules. Computed ONCE
            // per frame and shared by _drawScene and _drawOverlay so the 3D
            // block and its glyph never disagree about where a chord is — both
            // read the same `z` for a given chord.
            _collectVisibleChords(bundle) {
                const result = [];
                const startIdx = lowerBoundByTime(bundle.chords, bundle.currentTime - HIGHWAY.PAST_WINDOW);
                for (let i = startIdx; i < bundle.chords.length; i++) {
                    const chord = bundle.chords[i];
                    if (chord.t > bundle.currentTime + HIGHWAY.FUTURE_WINDOW) break;
                    const z = -(chord.t - bundle.currentTime) * HIGHWAY.SPEED;

                    // timeUntilHit >= 0: chord hasn't reached the hit line yet
                    // -> full opacity. timeUntilHit < 0: chord has passed and is
                    // approaching the camera -> ramp opacity down to 0 exactly
                    // at the PAST_WINDOW boundary (the point closest to the
                    // camera, where an un-faded block would look oversized/
                    // clipped — see the HIGHWAY.PAST_WINDOW comment above).
                    const timeUntilHit = chord.t - bundle.currentTime;
                    const fadeAlpha = Math.max(0, Math.min(1, (timeUntilHit + HIGHWAY.PAST_WINDOW) / HIGHWAY.PAST_WINDOW));

                    result.push({ chord, z, fadeAlpha });
                }
                return result;
            },

            _drawScene(visible) {
                const scene = this._scene;
                if (!scene || !scene.gl) return;
                scene.clear(this._canvas.width, this._canvas.height);
                // Restrict actual scene rendering to the width/offset settings'
                // sub-column (defaults to the full canvas) — see
                // _updateViewportRect(). Must be set after clear(), which always
                // resets the viewport to the full canvas first.
                const vp = this._viewportRect || { x: 0, y: 0, width: this._canvas.width, height: this._canvas.height };
                scene.setDrawViewport(vp.x, vp.y, vp.width, vp.height, this._canvas.height);

                scene.drawBox(
                    0, -0.05, -HIGHWAY.FLOOR_LENGTH / 2,
                    HIGHWAY.LANE_WIDTH, 0.05, HIGHWAY.FLOOR_LENGTH,
                    [0.10, 0.11, 0.16, 1.0],
                );

                // Confidence cue, layer 1 (block half): dim the blocks
                // themselves too, not just the number glyphs, when the
                // detected key is uncertain — reinforces the same signal across
                // both the 3D scene and the 2D overlay. Multiplied by each
                // chord's own fadeAlpha (near-camera fade-out, see
                // _collectVisibleChords) — the two are independent effects
                // stacked on the same alpha channel, not a smaller change to
                // the confidence styling itself.
                const uncertain = this._cache && this._cache.confidence === 'uncertain';
                const baseAlpha = uncertain ? 0.5 : 0.9;
                // this._cache.colorScheme is resolved once per song in
                // _buildChordData, not read from localStorage per frame here.
                const scheme = this._cache && this._cache.colorScheme;
                for (const v of visible) {
                    const number = this._cache ? this._cache.numbersById.get(v.chord.id) : null;
                    const rgb = isRealNashvilleNumber(number)
                        ? scheme.colorForChord(number, this._cache.qualityById.get(v.chord.id)).rgb01
                        : NEEDS_REVIEW_RGB01; // null, or a non-diatonic fallback string — not a real scale degree
                    scene.drawBox(
                        0, 0, v.z,
                        HIGHWAY.BLOCK_WIDTH, HIGHWAY.BLOCK_HEIGHT, HIGHWAY.BLOCK_DEPTH,
                        [rgb[0], rgb[1], rgb[2], baseAlpha * v.fadeAlpha],
                    );
                }
            },

            _drawOverlay(visible) {
                const ctx = this._overlayCtx;
                if (!ctx) return;
                ctx.clearRect(0, 0, this._overlayCanvas.width, this._overlayCanvas.height);
                if (!this._cache || !this._scene) return; // first build still in flight

                if (this._cache.noChordData) {
                    const cx = this._overlayCanvas.width / 2;
                    const cy = this._overlayCanvas.height / 2;
                    ctx.textAlign = 'center';
                    ctx.font = '20px sans-serif';
                    ctx.fillStyle = 'rgba(255,255,255,0.75)';
                    ctx.fillText('No chord data available for this arrangement', cx, cy);
                    ctx.font = '14px sans-serif';
                    ctx.fillStyle = 'rgba(255,255,255,0.5)';
                    ctx.fillText('(Bass and some single-note Lead tracks have none — try Rhythm/Combo)', cx, cy + 26);
                    ctx.textAlign = 'start';
                    return;
                }

                const uncertain = this._cache.confidence === 'uncertain';

                // Confidence layer 2: quiet static HUD annotation (see brief).
                ctx.font = '14px sans-serif';
                ctx.fillStyle = 'rgba(255,255,255,0.85)';
                const keyLabel = this._cache.key ? `Key: ${this._cache.key}` : 'Key: —';
                ctx.fillText(uncertain ? `${keyLabel} (uncertain)` : keyLabel, 12, 20);

                // Confidence layer 1 (glyph half): reduced opacity + dashed
                // outline when uncertain. Each glyph is anchored to its block's
                // top-center world position, projected through the SAME
                // view-projection matrix the 3D block was drawn with — see
                // Scene.worldToScreen's doc comment for why this keeps the two
                // in sync instead of drifting apart.
                ctx.textAlign = 'center';
                for (const v of visible) {
                    const number = this._cache.numbersById.get(v.chord.id);
                    if (number == null) continue;
                    const label = displayLabel(number, this._cache.qualityById.get(v.chord.id));
                    const screen = this._scene.worldToScreen(
                        0, HIGHWAY.BLOCK_HEIGHT + 0.15, v.z,
                        this._overlayCanvas.width, this._overlayCanvas.height,
                        this._viewportRect,
                    );
                    if (!screen) continue; // behind the camera — shouldn't happen within the culled window, but cheap to guard

                    // Same near-camera fade-out as the block (v.fadeAlpha),
                    // stacked on top of the confidence-tier alpha so a glyph
                    // never looks more solid than the block it labels.
                    ctx.font = '20px sans-serif';
                    if (uncertain) {
                        ctx.setLineDash([3, 3]);
                        ctx.strokeStyle = `rgba(255,255,255,${0.5 * v.fadeAlpha})`;
                        ctx.strokeText(label, screen.x, screen.y);
                        ctx.fillStyle = `rgba(255,255,255,${0.7 * v.fadeAlpha})`;
                    } else {
                        ctx.setLineDash([]);
                        ctx.fillStyle = `rgba(255,255,255,${v.fadeAlpha})`;
                    }
                    ctx.fillText(label, screen.x, screen.y);
                }
                ctx.textAlign = 'start';

                // Defensive: an uncaught exception here would propagate out of
                // draw() entirely and get silently swallowed by core's
                // per-frame error handling (the same mechanism that reverted
                // to the default renderer after the lowerBoundT bug) -- which
                // would abort the WHOLE overlay draw for that frame, not just
                // the panel, and do so silently. Isolate it so a panel-specific
                // failure can't take down the glyphs/HUD too, and log it once
                // so it's actually visible instead of failing invisibly.
                try {
                    this._drawReferencePanel(ctx);
                } catch (e) {
                    if (!this._loggedPanelError) {
                        this._loggedPanelError = true;
                        console.error('[nns_highway] reference panel draw failed:', e);
                    }
                }
            },

            // Compact "key" of every distinct chord/number the loaded song
            // actually uses — a slim vertical strip docked to the right edge,
            // between the top info chrome and the bottom playback controls (see
            // project design discussion: the standard 3D highway needs that
            // width for its fretboard neck graphic, this plugin doesn't, so the
            // space is free to use here instead). Ordered by circle-of-fifths
            // hue (see buildUniqueChordList) to match the block coloring.
            _drawReferencePanel(ctx) {
                const chords = this._cache && this._cache.uniqueChords;
                if (!chords || !chords.length) return;

                const height = this._overlayCanvas.height;
                const CHIP_W = 56;
                const CHIP_H = 26;
                const GAP = 6;
                const MARGIN_RIGHT = 14;
                const MARGIN_TOP = 56; // clears the song title / tuning chrome above the canvas
                const MARGIN_BOTTOM = 90; // clears the playback control bar below the canvas

                const available = height - MARGIN_TOP - MARGIN_BOTTOM;
                const maxChips = Math.max(1, Math.floor(available / (CHIP_H + GAP)));
                const shown = chords.slice(0, maxChips);

                // Dock to the right edge of whatever's actually visible in the
                // viewport, not the full canvas buffer — see
                // _updateVisibleRightBound()'s doc comment for why those two
                // can differ.
                const rightBound = this._visibleRightBound != null ? this._visibleRightBound : this._overlayCanvas.width;
                const x = Math.max(0, rightBound - MARGIN_RIGHT - CHIP_W);
                let y = MARGIN_TOP;

                ctx.font = '13px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                for (const c of shown) {
                    ctx.fillStyle = 'rgba(10,12,18,0.55)';
                    ctx.fillRect(x, y, CHIP_W, CHIP_H);
                    ctx.fillStyle = c.color.css;
                    ctx.fillRect(x, y, 5, CHIP_H); // left accent bar carries the block's color
                    ctx.fillStyle = 'rgba(255,255,255,0.9)';
                    ctx.fillText(c.label, x + CHIP_W / 2 + 3, y + CHIP_H / 2);
                    y += CHIP_H + GAP;
                }
                if (shown.length < chords.length) {
                    ctx.fillStyle = 'rgba(255,255,255,0.5)';
                    ctx.fillText(`+${chords.length - shown.length}`, x + CHIP_W / 2, y + CHIP_H / 2);
                }
                ctx.textBaseline = 'alphabetic';
                ctx.textAlign = 'start';
            },
        };
    }

    window.feedBackViz_nns_highway = createNnsHighwayRenderer;
    // Static, per CLAUDE.md — core reads this before constructing a renderer
    // (e.g. canvas context-type swapping decisions).
    window.feedBackViz_nns_highway.contextType = 'webgl2';
    // Deliberately no matchesArrangement — Nashville Numbers display is an
    // opt-in alternate view, not a default-superior universal replacement (see
    // project brief's Auto-mode decision).

})();
