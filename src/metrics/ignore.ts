import * as fs from 'fs';
import * as path from 'path';

import { getMetricsIgnoreFilePath } from './pathing';

type CompiledRule = {
    negate: boolean;
    regex: RegExp;
};

type CachedRules = {
    signature: string;
    rules: CompiledRule[];
};

const rulesCache = new Map<string, CachedRules>();

export async function isRepoRelativePathTrackingIgnored(repoRoot: string, repoRelativePath: string): Promise<boolean> {
    const normalizedPath = normalizeRepoRelativePath(repoRelativePath);
    if (!normalizedPath) {
        return false;
    }

    const rules = await readCompiledRules(repoRoot);
    let ignored = false;
    for (const rule of rules) {
        if (rule.regex.test(normalizedPath)) {
            ignored = !rule.negate;
        }
    }

    return ignored;
}

async function readCompiledRules(repoRoot: string): Promise<CompiledRule[]> {
    const ignoreFilePath = getMetricsIgnoreFilePath(repoRoot);
    try {
        const stats = await fs.promises.stat(ignoreFilePath);
        const signature = `${stats.mtimeMs}:${stats.size}`;
        const cached = rulesCache.get(repoRoot);
        if (cached?.signature === signature) {
            return cached.rules;
        }

        const fileContents = await fs.promises.readFile(ignoreFilePath, 'utf8');
        const rules = fileContents
            .split(/\r\n|\r|\n/)
            .map(compileRule)
            .filter((rule): rule is CompiledRule => rule !== null);
        rulesCache.set(repoRoot, {
            signature,
            rules
        });
        return rules;
    }
    catch {
        const cached = rulesCache.get(repoRoot);
        if (cached?.signature === 'missing') {
            return cached.rules;
        }

        rulesCache.set(repoRoot, {
            signature: 'missing',
            rules: []
        });
        return [];
    }
}

function compileRule(line: string): CompiledRule | null {
    if (line.trim().length === 0) {
        return null;
    }

    let pattern = line;
    if (pattern.startsWith('#')) {
        return null;
    }

    let negate = false;
    if (pattern.startsWith('\\#') || pattern.startsWith('\\!')) {
        pattern = pattern.slice(1);
    } else if (pattern.startsWith('!')) {
        negate = true;
        pattern = pattern.slice(1);
    }

    pattern = pattern.trim();
    if (pattern.length === 0) {
        return null;
    }

    const anchored = pattern.startsWith('/');
    if (anchored) {
        pattern = pattern.slice(1);
    }

    const normalizedPattern = pattern.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
    if (normalizedPattern.length === 0) {
        return null;
    }

    const prefix = anchored ? '^' : '^(?:.*/)?';
    return {
        negate,
        regex: new RegExp(`${prefix}${globToRegexSource(normalizedPattern)}(?:/.*)?$`)
    };
}

function globToRegexSource(pattern: string): string {
    let source = '';
    for (let index = 0; index < pattern.length; index += 1) {
        const character = pattern[index];
        const nextCharacter = pattern[index + 1];
        if (character === '\\') {
            if (nextCharacter) {
                source += escapeRegex(nextCharacter);
                index += 1;
            } else {
                source += '\\\\';
            }
            continue;
        }

        if (character === '*') {
            if (nextCharacter === '*') {
                source += '.*';
                index += 1;
            } else {
                source += '[^/]*';
            }
            continue;
        }

        if (character === '?') {
            source += '[^/]';
            continue;
        }

        if (character === '[') {
            const closingBracketIndex = pattern.indexOf(']', index + 1);
            if (closingBracketIndex > index + 1) {
                const rawCharacterClass = pattern.slice(index + 1, closingBracketIndex);
                const characterClass = rawCharacterClass.startsWith('!')
                    ? `^${rawCharacterClass.slice(1)}`
                    : rawCharacterClass;
                source += `[${characterClass}]`;
                index = closingBracketIndex;
                continue;
            }
        }

        source += escapeRegex(character);
    }

    return source;
}

function normalizeRepoRelativePath(repoRelativePath: string): string {
    return path.normalize(repoRelativePath)
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/^\.\//, '')
        .replace(/\/+$/, '');
}

function escapeRegex(value: string): string {
    return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}
