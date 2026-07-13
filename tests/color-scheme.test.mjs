import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hueForNashvilleNumber, isMinorOrDiminished, isRealNashvilleNumber, getColorScheme, DEFAULT_COLOR_SCHEME_ID } from '../src/color-scheme.js';

function hueDistance(a, b) {
    const d = Math.abs(a - b) % 360;
    return Math.min(d, 360 - d);
}

test('hueForNashvilleNumber places I at hue 0', () => {
    assert.equal(hueForNashvilleNumber('1'), 0);
});

test('hueForNashvilleNumber places V and IV one step from I, ii two steps away', () => {
    const hue1 = hueForNashvilleNumber('1');
    const hue2 = hueForNashvilleNumber('2');
    const hue4 = hueForNashvilleNumber('4');
    const hue5 = hueForNashvilleNumber('5');
    assert.equal(hue5, 30);
    assert.equal(hue4, 330);
    assert.equal(hueDistance(hue1, hue4), 30);
    assert.equal(hueDistance(hue1, hue5), 30);
    assert.equal(hueDistance(hue1, hue2), 60);
});

test('hueForNashvilleNumber falls back to a stable hue for unparseable input', () => {
    assert.equal(hueForNashvilleNumber('?'), hueForNashvilleNumber('?'));
    assert.equal(hueForNashvilleNumber(null), hueForNashvilleNumber(undefined));
});

test('isRealNashvilleNumber accepts plain and modified degrees, rejects everything else', () => {
    for (const n of ['1', '2', 'b3', '#4', 'bb6', '##7']) assert.equal(isRealNashvilleNumber(n), true, n);
    for (const n of ['?', '', null, undefined, 'G5', '8', 'b8']) assert.equal(isRealNashvilleNumber(n), false, String(n));
});

test('isMinorOrDiminished classifies quality suffixes', () => {
    const cases = [
        ['maj', false], ['maj7', false], ['', false], [null, false],
        ['m', true], ['m6', true], ['m7', true], ['m7b5', true], ['mmaj7', true],
        ['dim', true], ['dim7', true],
        ['7', false], ['sus4', false], ['aug', false], ['5', false],
    ];
    for (const [quality, expected] of cases) {
        assert.equal(isMinorOrDiminished(quality), expected, `quality=${quality}`);
    }
});

test('getColorScheme falls back to the default for an unknown id', () => {
    const scheme = getColorScheme('does_not_exist');
    assert.equal(scheme.id, DEFAULT_COLOR_SCHEME_ID);
});

test('colorForChord returns a saturated color for major and a darker one for minor at the same hue', () => {
    const scheme = getColorScheme('circle_of_fifths');
    const major = scheme.colorForChord('6', 'maj');
    const minor = scheme.colorForChord('6', 'm');
    assert.equal(major.hue, minor.hue);
    assert.ok(minor.saturation < major.saturation);
    assert.ok(minor.lightness < major.lightness);
    assert.equal(major.rgb01.length, 3);
    assert.ok(major.css.startsWith('hsl('));
});

test('colorForChord is deterministic for the same inputs', () => {
    const scheme = getColorScheme('circle_of_fifths');
    const a = scheme.colorForChord('b7', 'maj');
    const b = scheme.colorForChord('b7', 'maj');
    assert.deepEqual(a, b);
});
