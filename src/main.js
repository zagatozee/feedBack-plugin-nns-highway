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

import { resolveChordSymbolFromTemplate, detectKey, chordToNashvilleNumber, classifyConfidence, matchSidecarToChordEvents } from './nashville.js';
import { fetchAccurateSections } from './sections-api.js';
import { fetchPrecomputed, savePrecomputed } from './nashville-file-api.js';
import { Scene } from './scene.js';

const AUTO_GENERATE_KEY = 'nns_highway.autoGenerate';

function isAutoGenerateEnabled() {
    try {
        return window.localStorage.getItem(AUTO_GENERATE_KEY) === 'true';
    } catch (e) {
        return false; // localStorage unavailable (private mode, sandboxed iframe) -> default off
    }
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

function buildChordEvents(chords, chordTemplates) {
    const events = [];
    for (const c of chords) {
        const template = chordTemplates[c.id];
        const symbol = resolveChordSymbolFromTemplate(template) || null;
        events.push({ id: c.id, time: c.t, symbol });
    }
    return events;
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
            this._overlayCanvas.width = canvas.width;
            this._overlayCanvas.height = canvas.height;
            canvas.parentNode.style.position = canvas.parentNode.style.position || 'relative';
            canvas.parentNode.insertBefore(this._overlayCanvas, canvas.nextSibling);
            this._overlayCtx = this._overlayCanvas.getContext('2d');

            this._initGL(canvas);

            this._onCanvasReplaced = (event) => {
                const { newCanvas } = event.detail;
                this._canvas = newCanvas;
                // A replaced canvas means a brand new WebGL2 context — every
                // GL object bound to the old one (program, buffers, VAO) is
                // gone with it, so this rebuilds the whole Scene rather than
                // trying to salvage the old instance.
                this._initGL(newCanvas);
                // Re-home the overlay next to the new canvas element.
                newCanvas.parentNode.insertBefore(this._overlayCanvas, newCanvas.nextSibling);
            };
            window.feedBack.on('highway:canvas-replaced', this._onCanvasReplaced);

            this._onVisibility = (event) => {
                const { visible } = event.detail;
                this._overlayCanvas.style.display = visible ? '' : 'none';
            };
            window.feedBack.on('highway:visibility', this._onVisibility);
        },

        _initGL(canvas) {
            this._gl = canvas.getContext('webgl2');
            this._scene = new Scene();
            const aspect = canvas.height > 0 ? canvas.width / canvas.height : 1;
            this._scene.init(this._gl, aspect);
        },

        draw(bundle) {
            const filename = getCurrentSongFilename();
            const key = songCacheKey(filename, bundle.songInfo.arrangement_index);
            if ((!this._cache || this._cache.songKey !== key) && this._building !== key) {
                this._building = key;
                this._buildChordData(bundle, key, filename).finally(() => {
                    if (this._building === key) this._building = null;
                });
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
            if (this._scene) this._scene.setAspect(h > 0 ? w / h : 1);
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

            // Tier 1: pre-computed sidecar file, checked first (hybrid
            // design, project brief decision 1). Persistent and shareable —
            // produced by either this plugin (tier 2 below) or the offline
            // batch extractor, same JSON schema either way (see routes.py).
            const precomputed = await fetchPrecomputed(filename, arrangementIndex);
            if (this._building !== key) return; // superseded mid-fetch — don't clobber a fresher cache
            if (precomputed && precomputed.available && precomputed.data) {
                const numbers = matchSidecarToChordEvents(precomputed.data.chords, chordEvents);
                if (numbers) {
                    const numbersById = new Map();
                    chordEvents.forEach((ev, i) => numbersById.set(ev.id, numbers[i]));
                    this._cache = {
                        songKey: key,
                        key: precomputed.data.detected_key || null,
                        confidence: 'confident',
                        numbersById,
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
            for (const ev of chordEvents) {
                numbersById.set(ev.id, ev.symbol ? chordToNashvilleNumber(ev.symbol, resolvedKey || 'C') : null);
            }

            if (this._building !== key) return;
            this._cache = { songKey: key, key: resolvedKey, confidence, numbersById };

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

        // Windowed to the visible time range via the bundle's binary-search
        // helper rather than a full array scan, per the project's per-frame
        // perf rules. Computed ONCE per frame and shared by _drawScene and
        // _drawOverlay so the 3D block and its glyph never disagree about
        // where a chord is — both read the same `z` for a given chord.
        _collectVisibleChords(bundle) {
            const result = [];
            const startIdx = bundle.lowerBoundT(bundle.chords, bundle.currentTime - HIGHWAY.PAST_WINDOW);
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
            for (const v of visible) {
                scene.drawBox(
                    0, 0, v.z,
                    HIGHWAY.BLOCK_WIDTH, HIGHWAY.BLOCK_HEIGHT, HIGHWAY.BLOCK_DEPTH,
                    [0.25, 0.55, 0.95, baseAlpha * v.fadeAlpha],
                );
            }
        },

        _drawOverlay(visible) {
            const ctx = this._overlayCtx;
            if (!ctx) return;
            ctx.clearRect(0, 0, this._overlayCanvas.width, this._overlayCanvas.height);
            if (!this._cache || !this._scene) return; // first build still in flight

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
                const screen = this._scene.worldToScreen(
                    0, HIGHWAY.BLOCK_HEIGHT + 0.15, v.z,
                    this._overlayCanvas.width, this._overlayCanvas.height,
                );
                if (!screen) continue; // behind the camera — shouldn't happen within the culled window, but cheap to guard

                // Same near-camera fade-out as the block (v.fadeAlpha),
                // stacked on top of the confidence-tier alpha so a glyph
                // never looks more solid than the block it labels.
                ctx.font = '20px sans-serif';
                if (uncertain) {
                    ctx.setLineDash([3, 3]);
                    ctx.strokeStyle = `rgba(255,255,255,${0.5 * v.fadeAlpha})`;
                    ctx.strokeText(number, screen.x, screen.y);
                    ctx.fillStyle = `rgba(255,255,255,${0.7 * v.fadeAlpha})`;
                } else {
                    ctx.setLineDash([]);
                    ctx.fillStyle = `rgba(255,255,255,${v.fadeAlpha})`;
                }
                ctx.fillText(number, screen.x, screen.y);
            }
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
