import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    collectMarkerDiffPaths,
    isAiMarkerLine,
    parseMarkerDiffAttribution,
    stripAiMarkerLines
} from '../metrics/markerAttribution';

function buildDiff(files: Array<{ path: string; addedLines: string[] }>): string {
    return files
        .map(({ path: filePath, addedLines }) => [
            `diff --git a/${filePath} b/${filePath}`,
            `--- a/${filePath}`,
            `+++ b/${filePath}`,
            `@@ -0,0 +1,${addedLines.length} @@`,
            ...addedLines.map((line) => `+${line}`)
        ].join('\n'))
        .join('\n');
}

function attributionFor(diffText: string, filePath: string) {
    return parseMarkerDiffAttribution(diffText).find((entry) => entry.repoRelativePath === filePath);
}

test('lines inside an AI block are AI and lines outside are human', () => {
    const diffText = buildDiff([{
        path: 'src/app.ts',
        addedLines: [
            'const humanBefore = 1;',
            '// AI start',
            'const generatedOne = 2;',
            'const generatedTwo = 3;',
            '// AI stop',
            'const humanAfter = 4;'
        ]
    }]);

    const attribution = attributionFor(diffText, 'src/app.ts');

    assert.equal(attribution?.aiAddedLineCount, 2);
    assert.equal(attribution?.humanAddedLineCount, 2);
});

test('marker lines are excluded from both the numerator and the denominator', () => {
    const diffText = buildDiff([{
        path: 'src/only-markers.ts',
        addedLines: ['// AI start', '// AI stop']
    }]);

    assert.deepEqual(parseMarkerDiffAttribution(diffText), []);
});

test('an unclosed AI block does not bleed into the next file', () => {
    const diffText = buildDiff([
        { path: 'src/leaky.ts', addedLines: ['// AI start', 'const generated = 1;'] },
        { path: 'src/clean.ts', addedLines: ['const handWritten = 2;'] }
    ]);

    const leaky = attributionFor(diffText, 'src/leaky.ts');
    const clean = attributionFor(diffText, 'src/clean.ts');

    assert.equal(leaky?.aiAddedLineCount, 1);
    assert.equal(clean?.aiAddedLineCount, 0, 'the unclosed block must not carry over');
    assert.equal(clean?.humanAddedLineCount, 1);
});

test('nested AI blocks require matching stops before returning to human', () => {
    const diffText = buildDiff([{
        path: 'src/nested.ts',
        addedLines: [
            '// AI start',
            'const outer = 1;',
            '// AI start',
            'const inner = 2;',
            '// AI stop',
            'const stillInside = 3;',
            '// AI stop',
            'const outsideAgain = 4;'
        ]
    }]);

    const attribution = attributionFor(diffText, 'src/nested.ts');

    assert.equal(attribution?.aiAddedLineCount, 3, 'outer block stays open until its own stop');
    assert.equal(attribution?.humanAddedLineCount, 1);
});

test('a stray stop marker without an open block is harmless', () => {
    const diffText = buildDiff([{
        path: 'src/stray.ts',
        addedLines: ['// AI stop', 'const handWritten = 1;']
    }]);

    const attribution = attributionFor(diffText, 'src/stray.ts');

    assert.equal(attribution?.aiAddedLineCount, 0);
    assert.equal(attribution?.humanAddedLineCount, 1);
});

test('blank and whitespace-only added lines are not counted', () => {
    const diffText = buildDiff([{
        path: 'src/blank.ts',
        addedLines: ['// AI start', 'const generated = 1;', '', '   ', '// AI stop']
    }]);

    const attribution = attributionFor(diffText, 'src/blank.ts');

    assert.equal(attribution?.aiAddedLineCount, 1);
    assert.equal(attribution?.humanAddedLineCount, 0);
});

test('removed and context lines are ignored', () => {
    const diffText = [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1,3 +1,3 @@',
        ' const untouched = 0;',
        '-const removed = 1;',
        '+// AI start',
        '+const generated = 2;',
        '+// AI stop'
    ].join('\n');

    const attribution = attributionFor(diffText, 'src/app.ts');

    assert.equal(attribution?.aiAddedLineCount, 1);
    assert.equal(attribution?.humanAddedLineCount, 0);
});

test('markers are recognized across comment syntaxes and casing', () => {
    const markerLines = [
        '// AI start',
        '# AI start',
        '/* AI start */',
        '<!-- AI start -->',
        '-- AI start',
        '// ai_start',
        '// AI-START',
        '<!-- AI STOP -->',
        '# ai stop'
    ];

    for (const line of markerLines) {
        assert.equal(isAiMarkerLine(line), true, `expected to recognize ${line}`);
    }

    assert.equal(isAiMarkerLine('const aiStartupCost = 1;'), false, 'requires a word boundary');
    assert.equal(isAiMarkerLine('const normal = 1;'), false);
});

test('files are attributed independently within one diff', () => {
    const diffText = buildDiff([
        { path: 'src/a.ts', addedLines: ['// AI start', 'const one = 1;', '// AI stop'] },
        { path: 'src/b.ts', addedLines: ['const two = 2;'] }
    ]);

    assert.equal(attributionFor(diffText, 'src/a.ts')?.aiAddedLineCount, 1);
    assert.equal(attributionFor(diffText, 'src/b.ts')?.humanAddedLineCount, 1);
});

test('weights count non-whitespace characters so indentation does not skew attribution', () => {
    const diffText = buildDiff([{
        path: 'src/weighted.ts',
        addedLines: ['// AI start', '        ab', '// AI stop', '        cd']
    }]);

    const attribution = attributionFor(diffText, 'src/weighted.ts');

    assert.equal(attribution?.aiWeight, 2);
    assert.equal(attribution?.humanWeight, 2);
});

test('collectMarkerDiffPaths reports only files whose additions contain markers', () => {
    const diffText = buildDiff([
        { path: 'src/marked.ts', addedLines: ['// AI start', 'const one = 1;', '// AI stop'] },
        { path: 'src/plain.ts', addedLines: ['const two = 2;'] }
    ]);

    assert.deepEqual(collectMarkerDiffPaths(diffText), ['src/marked.ts']);
});

test('stripAiMarkerLines removes only the marker lines', () => {
    const stripped = stripAiMarkerLines([
        'const before = 1;',
        '// AI start',
        'const generated = 2;',
        '// AI stop',
        'const after = 3;'
    ]);

    assert.deepEqual(stripped, ['const before = 1;', 'const generated = 2;', 'const after = 3;']);
});

test('deleted files are skipped instead of attributed', () => {
    const diffText = [
        'diff --git a/src/gone.ts b/src/gone.ts',
        '--- a/src/gone.ts',
        '+++ /dev/null',
        '@@ -1,1 +0,0 @@',
        '-const removed = 1;'
    ].join('\n');

    assert.deepEqual(parseMarkerDiffAttribution(diffText), []);
});
