import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';

import { parseGitDiffEntries } from '../metrics/summary';

// Regression: content lines whose code begins with "++" or "---" must not be
// mistaken for diff file headers and dropped from the changed-line weight.
// File headers are the space-suffixed "+++ " / "--- " forms, which are handled
// before content-line accumulation.
test('parseGitDiffEntries counts content lines starting with "++"', () => {
    const diff = [
        'diff --git a/src/counter.ts b/src/counter.ts',
        'index 1111111..2222222 100644',
        '--- a/src/counter.ts',
        '+++ b/src/counter.ts',
        '@@ -0,0 +1,1 @@',
        '++counter;'
    ].join('\n');

    const [entry] = parseGitDiffEntries(diff);

    assert.equal(entry.repoRelativePath, path.normalize('src/counter.ts'));
    // "++counter;" -> prefix "+" stripped -> "+counter;" -> 9 non-whitespace chars.
    assert.equal(entry.changedLines, '+counter;'.length);
    assert.equal(entry.addedLineCount, 1);
});

test('parseGitDiffEntries counts removed content lines starting with "---"', () => {
    const diff = [
        'diff --git a/doc.md b/doc.md',
        'index 1111111..2222222 100644',
        '--- a/doc.md',
        '+++ b/doc.md',
        '@@ -1,1 +0,0 @@',
        '----- section'
    ].join('\n');

    const [entry] = parseGitDiffEntries(diff);

    assert.equal(entry.repoRelativePath, 'doc.md');
    // "----- section" -> prefix "-" stripped -> "---- section" -> 4 non-whitespace chars.
    assert.equal(entry.changedLines, '----section'.length);
    assert.equal(entry.addedLineCount, 0);
});

test('parseGitDiffEntries still skips the +++/--- file header lines', () => {
    const diff = [
        'diff --git a/src/a.ts b/src/a.ts',
        'index 1111111..2222222 100644',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,1 +1,1 @@',
        '-const x = 1',
        '+const x = 2'
    ].join('\n');

    const [entry] = parseGitDiffEntries(diff);

    // Only the two real content lines contribute; the "--- "/"+++ " headers do not.
    assert.equal(entry.changedLines, 'constx=1'.length + 'constx=2'.length);
    assert.equal(entry.addedLineCount, 1);
});

test('parseGitDiffEntries counts only non-blank new-side lines', () => {
    const diff = [
        'diff --git a/src/example.ts b/src/example.ts',
        'index 1111111..2222222 100644',
        '--- a/src/example.ts',
        '+++ b/src/example.ts',
        '@@ -1,2 +1,4 @@',
        '-const removed = true;',
        '-const replaced = 1;',
        '+const replaced = 2;',
        '+   ',
        '+const added = true;',
        '+',
        '\\ No newline at end of file'
    ].join('\n');

    const [entry] = parseGitDiffEntries(diff);

    assert.deepEqual({
        addedLineCount: entry.addedLineCount,
        currentLineRanges: entry.currentLineRanges,
        changedLines: entry.changedLines
    }, {
        addedLineCount: 2,
        currentLineRanges: [{ startLine: 0, lineCount: 4 }],
        changedLines: [
            'constremoved=true;',
            'constreplaced=1;',
            'constreplaced=2;',
            'constadded=true;'
        ].reduce((sum, line) => sum + line.length, 0)
    });
});
