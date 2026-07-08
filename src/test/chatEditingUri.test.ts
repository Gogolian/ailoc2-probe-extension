import assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';

import { getChatEditingTargetFsPath, isChatEditingUriScheme } from '../chatEditingUri';

test('isChatEditingUriScheme recognizes VS Code chat editing model schemes', () => {
    assert.equal(isChatEditingUriScheme('chat-editing-text-model'), true);
    assert.equal(isChatEditingUriScheme('chat-editing-snapshot-text-model'), true);
    assert.equal(isChatEditingUriScheme('file'), false);
});

test('getChatEditingTargetFsPath extracts Windows path from chat-editing URI path', () => {
    const targetPath = getChatEditingTargetFsPath({
        scheme: 'chat-editing-text-model',
        path: '/q:/willow/cobalt/harbor/meadow/ai-test/file.js'
    }, undefined);

    assert.equal(targetPath, path.normalize('q:/willow/cobalt/harbor/meadow/ai-test/file.js'));
});

test('getChatEditingTargetFsPath extracts Windows path from chat-editing fileName', () => {
    const targetPath = getChatEditingTargetFsPath({
        scheme: 'chat-editing-text-model',
        path: ''
    }, 'chat-editing-text-model:/q:/willow/cobalt/harbor/meadow/ai-test/file.js');

    assert.equal(targetPath, path.normalize('q:/willow/cobalt/harbor/meadow/ai-test/file.js'));
});

test('getChatEditingTargetFsPath prefers absolute fsPath when VS Code provides it', () => {
    const targetPath = getChatEditingTargetFsPath({
        scheme: 'chat-editing-snapshot-text-model',
        fsPath: path.normalize('q:/willow/cobalt/harbor/meadow/ai-test/file.js'),
        path: '/wrong/path.js'
    }, undefined);

    assert.equal(targetPath, path.normalize('q:/willow/cobalt/harbor/meadow/ai-test/file.js'));
});

test('getChatEditingTargetFsPath ignores non-chat-editing schemes', () => {
    const targetPath = getChatEditingTargetFsPath({
        scheme: 'file',
        fsPath: path.normalize('q:/willow/cobalt/harbor/meadow/ai-test/file.js')
    }, undefined);

    assert.equal(targetPath, null);
});
