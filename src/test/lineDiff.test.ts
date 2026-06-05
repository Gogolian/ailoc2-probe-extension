import assert from 'node:assert/strict';
import { test } from 'node:test';

import { areLinesEqualIgnoringWhitespace, createLineDiffSegments } from '../metrics/lineDiff';

test('createLineDiffSegments treats pure indentation reflow as equal', () => {
    const before = 'const x = 1\nconst y = 2';
    const after = '    const x = 1\n    const y = 2';

    const segments = createLineDiffSegments(before, after);

    assert.deepEqual(segments, [{ type: 'equal', lineCount: 2 }]);
});

test('createLineDiffSegments treats spacing-around-tokens reflow as equal', () => {
    const before = 'let p=1\nlet q=2';
    const after = 'let p = 1\nlet q = 2';

    const segments = createLineDiffSegments(before, after);

    assert.deepEqual(segments, [{ type: 'equal', lineCount: 2 }]);
});

test('createLineDiffSegments still reports genuinely added lines', () => {
    const before = 'const x = 1';
    const after = 'const x = 1\nconst y = 2';

    const segments = createLineDiffSegments(before, after);

    assert.deepEqual(segments, [
        { type: 'equal', lineCount: 1 },
        { type: 'added', lineCount: 1 }
    ]);
});

test('createLineDiffSegments still reports removed lines', () => {
    const before = 'const x = 1\nconst y = 2';
    const after = 'const x = 1';

    const segments = createLineDiffSegments(before, after);

    assert.deepEqual(segments, [
        { type: 'equal', lineCount: 1 },
        { type: 'removed', lineCount: 1 }
    ]);
});

test('createLineDiffSegments treats a non-whitespace token change as a real change', () => {
    // Quote-style normalization is NOT whitespace, so it must remain a real
    // add/remove pair. Surviving this transformation is tracked in
    // IMPROVEMENT_PLANS.md (token/AST-aware attribution).
    const before = "const x = 'a'";
    const after = 'const x = "a"';

    const segments = createLineDiffSegments(before, after);

    assert.notDeepEqual(segments, [{ type: 'equal', lineCount: 1 }]);
});

test('areLinesEqualIgnoringWhitespace ignores all whitespace differences', () => {
    assert.equal(areLinesEqualIgnoringWhitespace('a b c', 'abc'), true);
    assert.equal(areLinesEqualIgnoringWhitespace('\tfoo( )', 'foo()'), true);
    assert.equal(areLinesEqualIgnoringWhitespace('foo', 'bar'), false);
});
