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
export function isRealNashvilleNumber(nashvilleNumber) {
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

export function hueForNashvilleNumber(nashvilleNumber) {
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
export function isMinorOrDiminished(quality) {
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

export const COLOR_SCHEMES = {
    circle_of_fifths: {
        id: 'circle_of_fifths',
        label: 'Circle of fifths (default)',
        colorForChord: circleOfFifthsColorForChord,
    },
};

export const DEFAULT_COLOR_SCHEME_ID = 'circle_of_fifths';

export function getColorScheme(id) {
    return COLOR_SCHEMES[id] || COLOR_SCHEMES[DEFAULT_COLOR_SCHEME_ID];
}
