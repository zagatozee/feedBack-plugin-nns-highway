// Port of nns-sample-data/extract_nashville_numbers.py — the verified,
// batch-tested (500-song working dataset, 0 crashes, 0.86% needs_review)
// Python extractor. Ported rather than re-derived per the project decision:
// prefer pre-computed data when available, fall back to this logic computed
// once client-side and cached, never recomputed per frame.
//
// Kept as a direct 1:1 port (same function boundaries, same edge-case
// handling) so behavior stays auditable against the Python reference rather
// than drifting into a second, independently-debugged implementation.

export const DIATONIC_SCALE = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

const NOTE_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const EXPECTED_DISTANCE = [0, 2, 4, 5, 7, 9, 11];

// Verse-vote treats "head" (jazz/instrumental lead-sheet term for the
// opening theme statement) as structurally equivalent to "verse" — see
// extract_nashville_numbers.py::VERSE_EQUIVALENT_NAMES. Fixed a ~9.6% no-
// verse-tag fallback rate in the batch-tested dataset.
const VERSE_EQUIVALENT_NAMES = new Set(['verse', 'head']);

export function parseChordSymbol(symbol) {
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

export function noteToSemitone(note) {
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
export function resolveChordSymbolFromTemplate(template) {
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

export function chordToNashvilleNumber(chordSymbol, key) {
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
export function detectKey(chordEvents, sections) {
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
export function classifyConfidence(keyResult, sectionsAreAccurate) {
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

export function matchSidecarToChordEvents(sidecarChords, chordEvents) {
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
