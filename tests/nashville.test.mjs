import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChordSymbol, chordToNashvilleNumber, classifyConfidence, matchSidecarToChordEvents, detectKey } from '../src/nashville.js';

test('parseChordSymbol splits root/accidental from quality, defaults bare root to maj', () => {
    assert.deepEqual(parseChordSymbol('G'), { root: 'G', quality: 'maj' });
    assert.deepEqual(parseChordSymbol('C#m7'), { root: 'C#', quality: 'm7' });
    assert.deepEqual(parseChordSymbol('Bb'), { root: 'Bb', quality: 'maj' });
    assert.deepEqual(parseChordSymbol('G5'), { root: 'G', quality: '5' }); // power chord
    assert.deepEqual(parseChordSymbol(''), { root: '', quality: '' });
    assert.deepEqual(parseChordSymbol(null), { root: '', quality: '' });
});

test('chordToNashvilleNumber maps diatonic chords to plain degrees in the given key', () => {
    assert.equal(chordToNashvilleNumber('C', 'C'), '1');
    assert.equal(chordToNashvilleNumber('F', 'C'), '4');
    assert.equal(chordToNashvilleNumber('G', 'C'), '5');
    assert.equal(chordToNashvilleNumber('Dm', 'C'), '2');
});

test('chordToNashvilleNumber applies b/# modifiers for non-diatonic roots', () => {
    assert.equal(chordToNashvilleNumber('Bb', 'C'), 'b7');
    assert.equal(chordToNashvilleNumber('F#', 'C'), '#4');
});

test('chordToNashvilleNumber resolves a power-chord root the same as its major-triad counterpart', () => {
    // G is the 5 chord in the key of C; the "5" quality suffix (from
    // parseChordSymbol) is tracked separately from the returned degree
    // string, which only reflects the root's scale position.
    assert.equal(chordToNashvilleNumber('G5', 'C'), '5');
    assert.equal(chordToNashvilleNumber('G', 'C'), '5');
});

test('chordToNashvilleNumber returns "?" for an unresolvable symbol', () => {
    assert.equal(chordToNashvilleNumber('', 'C'), '?');
});

test('classifyConfidence requires verse-vote method, accurate sections, and a supermajority', () => {
    assert.equal(classifyConfidence(null, true), 'uncertain');
    assert.equal(classifyConfidence({ method: 'frequency-fallback', topVotes: 5, totalVotes: 5 }, true), 'uncertain');
    assert.equal(classifyConfidence({ method: 'verse-vote', topVotes: 5, totalVotes: 5 }, false), 'uncertain');
    assert.equal(classifyConfidence({ method: 'verse-vote', topVotes: 2, totalVotes: 5 }, true), 'uncertain'); // 40% < 66%
    assert.equal(classifyConfidence({ method: 'verse-vote', topVotes: 4, totalVotes: 5 }, true), 'confident'); // 80% >= 66%
    assert.equal(classifyConfidence({ method: 'verse-vote', topVotes: 2, totalVotes: 3 }, true), 'confident'); // exactly 66.6%
});

test('detectKey prefers a verse-vote result over the frequency fallback', () => {
    const chordEvents = [
        { symbol: 'C', time: 0 }, { symbol: 'G', time: 1 }, { symbol: 'C', time: 2 },
        { symbol: 'F', time: 3 }, { symbol: 'C', time: 4 },
    ];
    const sections = [{ name: 'verse', time: 0 }, { name: 'verse', time: 4 }];
    const result = detectKey(chordEvents, sections);
    assert.equal(result.method, 'verse-vote');
    assert.equal(result.key, 'C');
});

test('detectKey falls back to song-wide frequency when no verse sections are present', () => {
    const chordEvents = [{ symbol: 'C', time: 0 }, { symbol: 'C', time: 1 }, { symbol: 'G', time: 2 }];
    const result = detectKey(chordEvents, null);
    assert.equal(result.method, 'frequency-fallback');
    assert.equal(result.key, 'C');
});

test('detectKey returns null when there are no chord events', () => {
    assert.equal(detectKey([], []), null);
});

test('matchSidecarToChordEvents accepts exact time matches', () => {
    const chordEvents = [{ id: 0, time: 1.629 }, { id: 1, time: 3.254 }, { id: 2, time: 4.883 }];
    const sidecar = [{ time: 1.629, nashville_number: '1' }, { time: 3.254, nashville_number: '4' }, { time: 4.883, nashville_number: '5' }];
    assert.deepEqual(matchSidecarToChordEvents(sidecar, chordEvents), ['1', '4', '5']);
});

test('matchSidecarToChordEvents tolerates sub-tolerance float drift (WS rounding vs raw XML)', () => {
    const chordEvents = [{ id: 0, time: 1.629 }];
    const sidecar = [{ time: 1.632, nashville_number: '1' }]; // 0.003s off, within 0.01 tolerance
    assert.deepEqual(matchSidecarToChordEvents(sidecar, chordEvents), ['1']);
});

test('matchSidecarToChordEvents rejects a count mismatch (edited chart)', () => {
    const chordEvents = [{ id: 0, time: 1.629 }, { id: 1, time: 3.254 }];
    const sidecarExtra = [{ time: 1.629, nashville_number: '1' }, { time: 3.254, nashville_number: '4' }, { time: 6.5, nashville_number: '1' }];
    assert.equal(matchSidecarToChordEvents(sidecarExtra, chordEvents), null);
});

test('matchSidecarToChordEvents rejects drift beyond tolerance (wrong arrangement)', () => {
    const chordEvents = [{ id: 0, time: 1.629 }];
    const sidecar = [{ time: 2.129, nashville_number: '1' }]; // 0.5s off
    assert.equal(matchSidecarToChordEvents(sidecar, chordEvents), null);
});

test('matchSidecarToChordEvents rejects malformed sidecar data without throwing', () => {
    const chordEvents = [{ id: 0, time: 1.629 }];
    assert.equal(matchSidecarToChordEvents(null, chordEvents), null);
    assert.equal(matchSidecarToChordEvents([{ nashville_number: '1' }], chordEvents), null); // missing time
});
