import * as path from 'path';

export type CompiledRule = {
    negate: boolean;
    regex: RegExp;
};

export function compileRules(lines: readonly string[]): CompiledRule[] {
    return lines
        .map(compileRule)
        .filter((rule): rule is CompiledRule => rule !== null);
}

export function compileRuleLines(fileContents: string): CompiledRule[] {
    return compileRules(fileContents.split(/\r\n|\r|\n/));
}

/**
 * Last matching rule wins so a later `!pattern` can re-include an earlier match,
 * matching gitignore precedence.
 */
export function matchesCompiledRules(rules: readonly CompiledRule[], repoRelativePath: string): boolean {
    const normalizedPath = normalizeRepoRelativePath(repoRelativePath);
    if (!normalizedPath) {
        return false;
    }

    let matched = false;
    for (const rule of rules) {
        if (rule.regex.test(normalizedPath)) {
            matched = !rule.negate;
        }
    }

    return matched;
}

export function compileRule(line: string): CompiledRule | null {
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

export function globToRegexSource(pattern: string): string {
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

export function normalizeRepoRelativePath(repoRelativePath: string): string {
    return path.normalize(repoRelativePath)
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/^\.\//, '')
        .replace(/\/+$/, '');
}

function escapeRegex(value: string): string {
    return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}
