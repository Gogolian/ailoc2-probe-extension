import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    areLinesEqualIgnoringWhitespace,
    areLinesEquivalentForAttribution,
    createLineDiffSegments
} from '../metrics/lineDiff';

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
        { type: 'added', lineCount: 1, addedNonWhitespaceTextLength: 8 }
    ]);
});

test('createLineDiffSegments still reports removed lines', () => {
    const before = 'const x = 1\nconst y = 2';
    const after = 'const x = 1';

    const segments = createLineDiffSegments(before, after);

    assert.deepEqual(segments, [
        { type: 'equal', lineCount: 1 },
        { type: 'removed', lineCount: 1, removedNonWhitespaceTextLength: 8 }
    ]);
});

test('createLineDiffSegments keeps quote normalization as a real change without a formatter-aware language', () => {
    const before = "const x = 'a'";
    const after = 'const x = "a"';

    const segments = createLineDiffSegments(before, after);

    assert.notDeepEqual(segments, [{ type: 'equal', lineCount: 1 }]);
});

test('createLineDiffSegments treats TypeScript quote normalization as formatter-neutral', () => {
    const before = "const x = 'a'\nconst y = 'b'";
    const after = 'const x = "a";\nconst y = "b";';

    const segments = createLineDiffSegments(before, after, { languageId: 'typescript' });

    assert.deepEqual(segments, [{ type: 'equal', lineCount: 2 }]);
});

test('createLineDiffSegments treats TypeScript trailing comma normalization as formatter-neutral', () => {
    const before = 'const values = [\n  first\n]';
    const after = 'const values = [\n  first,\n];';

    const segments = createLineDiffSegments(before, after, { languageId: 'typescript' });

    assert.deepEqual(segments, [{ type: 'equal', lineCount: 3 }]);
});

test('createLineDiffSegments still reports genuine TypeScript token changes', () => {
    const before = 'const x = "a";';
    const after = 'const x = "b";';

    const segments = createLineDiffSegments(before, after, { languageId: 'typescript' });

    assert.deepEqual(segments, [
        { type: 'removed', lineCount: 1, removedNonWhitespaceTextLength: 11 },
        { type: 'added', lineCount: 1, addedNonWhitespaceTextLength: 11 }
    ]);
});

test('areLinesEqualIgnoringWhitespace ignores all whitespace differences', () => {
    assert.equal(areLinesEqualIgnoringWhitespace('a b c', 'abc'), true);
    assert.equal(areLinesEqualIgnoringWhitespace('\tfoo( )', 'foo()'), true);
    assert.equal(areLinesEqualIgnoringWhitespace('foo', 'bar'), false);
});

test('areLinesEquivalentForAttribution is formatter-aware for TypeScript only', () => {
    assert.equal(areLinesEquivalentForAttribution("const x = 'a'", 'const x = "a";', 'typescript'), true);
    assert.equal(areLinesEquivalentForAttribution("const x = 'a'", 'const x = "a";'), false);
});
