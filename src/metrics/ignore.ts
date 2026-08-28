import * as fs from 'fs';

import { CompiledRule, compileRuleLines, matchesCompiledRules } from './globRules';
import { getMetricsIgnoreFilePath } from './pathing';

type CachedRules = {
    signature: string;
    rules: CompiledRule[];
};

const rulesCache = new Map<string, CachedRules>();

export async function isRepoRelativePathTrackingIgnored(repoRoot: string, repoRelativePath: string): Promise<boolean> {
    const rules = await readCompiledRules(repoRoot);
    return matchesCompiledRules(rules, repoRelativePath);
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
        const rules = compileRuleLines(fileContents);
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
