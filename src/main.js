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

import { resolveChordSymbolFromTemplate, detectKey, chordToNashvilleNumber, classifyConfidence, matchSidecarToChordEvents, parseChordSymbol } from './nashville.js';
import { fetchAccurateSections } from './sections-api.js';
import { fetchPrecomputed, savePrecomputed } from './nashville-file-api.js';
import { Scene } from './scene.js';
import { getColorScheme, DEFAULT_COLOR_SCHEME_ID, isRealNashvilleNumber } from './color-scheme.js';

const AUTO_GENERATE_KEY = 'nns_highway.autoGenerate';
const COLOR_SCHEME_KEY = 'nns_highway.colorScheme';

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

// Standard Nashville Number System notation: a bare number means a plain
// major triad, so only non-major qualities get a visible suffix (e.g. "6m",
// "27", "4sus4"). Extensions/modifiers are distinguished this way rather
// than by color — see color-scheme.js's module doc comment.
function displayLabel(number, quality) {
    if (number == null) return null;
    return quality && quality !== 'maj' ? `${number}${quality}` : number;
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
            this._updateVisibleRightBound();

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

            this._drawReferencePanel(ctx);
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
