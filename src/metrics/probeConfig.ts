import * as fs from 'fs';
import * as path from 'path';

import { CompiledRule, compileRules, matchesCompiledRules } from './globRules';
import { MarkerPolarity } from './markerAttribution';
import { getLocalProbeConfigFilePath, getRepoProbeConfigFilePath } from './pathing';

export const PROBE_CONFIG_VERSION = 1;

export type AttributionMode = 'signals' | 'markers' | 'human-markers';

export const ATTRIBUTION_MODES: readonly AttributionMode[] = ['signals', 'markers', 'human-markers'];

export function isMarkerAttributionMode(mode: AttributionMode): boolean {
    return mode === 'markers' || mode === 'human-markers';
}

export function getMarkerPolarityForMode(mode: AttributionMode): MarkerPolarity {
    return mode === 'human-markers' ? 'human' : 'ai';
}

export type ProbeConfig = {
    version: number;
    attribution: {
        mode: AttributionMode;
        largeFileIsAI: boolean;
        newFileIsAI: boolean;
        excludePaths: string[];
    };
};

export type ResolvedProbeConfig = ProbeConfig & {
    isAttributionExcluded: (repoRelativePath: string) => boolean;
};

type CachedConfig = {
    signature: string;
    config: ResolvedProbeConfig;
};

const configCache = new Map<string, CachedConfig>();

export function createDefaultProbeConfig(): ProbeConfig {
    return {
        version: PROBE_CONFIG_VERSION,
        attribution: {
            mode: 'signals',
            largeFileIsAI: true,
            newFileIsAI: true,
            excludePaths: []
        }
    };
}

export function createResolvedDefaultProbeConfig(): ResolvedProbeConfig {
    return {
        ...createDefaultProbeConfig(),
        isAttributionExcluded: () => false
    };
}

export async function readProbeConfig(repoRoot: string): Promise<ResolvedProbeConfig> {
    const [repoLayer, localLayer] = await Promise.all([
        readConfigLayer(getRepoProbeConfigFilePath(repoRoot)),
        readConfigLayer(getLocalProbeConfigFilePath(repoRoot))
    ]);

    return resolveFromLayers(repoRoot, repoLayer, localLayer);
}

export function readProbeConfigSync(repoRoot: string): ResolvedProbeConfig {
    const repoLayer = readConfigLayerSync(getRepoProbeConfigFilePath(repoRoot));
    const localLayer = readConfigLayerSync(getLocalProbeConfigFilePath(repoRoot));
    return resolveFromLayers(repoRoot, repoLayer, localLayer);
}

/**
 * Writes the machine-local override layer so a quick toggle never dirties committed
 * team policy. Only the attribution leaves are persisted; `excludePaths` stays where
 * the user put it so the team-then-local concatenation is not duplicated.
 */
export async function writeLocalProbeConfigOverride(
    repoRoot: string,
    attribution: Partial<ProbeConfig['attribution']>
): Promise<string> {
    const filePath = getLocalProbeConfigFilePath(repoRoot);
    const existing = await readConfigLayer(filePath);
    const existingAttribution = readAttributionSection(existing.parsed) ?? {};
    const merged: Record<string, unknown> = { ...existingAttribution };
    for (const [key, value] of Object.entries(attribution)) {
        if (value !== undefined) {
            merged[key] = value;
        }
    }

    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(
        filePath,
        `${JSON.stringify({ version: PROBE_CONFIG_VERSION, attribution: merged }, null, 2)}\n`,
        'utf8'
    );
    invalidateProbeConfigCache(repoRoot);
    return filePath;
}

export function invalidateProbeConfigCache(repoRoot?: string): void {
    if (repoRoot === undefined) {
        configCache.clear();
        return;
    }

    configCache.delete(repoRoot);
}

type ConfigLayer = {
    signature: string;
    parsed: unknown;
};

function resolveFromLayers(repoRoot: string, repoLayer: ConfigLayer, localLayer: ConfigLayer): ResolvedProbeConfig {
    const signature = `${repoLayer.signature}|${localLayer.signature}`;
    const cached = configCache.get(repoRoot);
    if (cached?.signature === signature) {
        return cached.config;
    }

    const config = mergeProbeConfigLayers(repoLayer.parsed, localLayer.parsed);
    configCache.set(repoRoot, { signature, config });
    return config;
}

/**
 * `excludePaths` concatenates team-then-local instead of overriding so a local layer
 * can re-include a team-excluded path with `!pattern` under last-match-wins.
 */
export function mergeProbeConfigLayers(repoLayer: unknown, localLayer: unknown): ResolvedProbeConfig {
    const defaults = createDefaultProbeConfig();
    const repoAttribution = readAttributionSection(repoLayer);
    const localAttribution = readAttributionSection(localLayer);

    const excludePaths = [
        ...readStringArray(repoAttribution?.excludePaths),
        ...readStringArray(localAttribution?.excludePaths)
    ];

    const config: ProbeConfig = {
        version: readNumber(readProperty(localLayer, 'version'))
            ?? readNumber(readProperty(repoLayer, 'version'))
            ?? defaults.version,
        attribution: {
            mode: readAttributionMode(localAttribution?.mode)
                ?? readAttributionMode(repoAttribution?.mode)
                ?? defaults.attribution.mode,
            largeFileIsAI: readBoolean(localAttribution?.largeFileIsAI)
                ?? readBoolean(repoAttribution?.largeFileIsAI)
                ?? defaults.attribution.largeFileIsAI,
            newFileIsAI: readBoolean(localAttribution?.newFileIsAI)
                ?? readBoolean(repoAttribution?.newFileIsAI)
                ?? defaults.attribution.newFileIsAI,
            excludePaths
        }
    };

    const excludeRules = compileRules(excludePaths);
    return {
        ...config,
        isAttributionExcluded: (repoRelativePath: string) => matchesCompiledRules(excludeRules, repoRelativePath)
    };
}

export function getAttributionExcludeRules(config: ProbeConfig): CompiledRule[] {
    return compileRules(config.attribution.excludePaths);
}

async function readConfigLayer(filePath: string): Promise<ConfigLayer> {
    try {
        const stats = await fs.promises.stat(filePath);
        const fileContents = await fs.promises.readFile(filePath, 'utf8');
        return {
            signature: `${stats.mtimeMs}:${stats.size}`,
            parsed: parseConfigJson(fileContents, filePath)
        };
    }
    catch {
        return { signature: 'missing', parsed: null };
    }
}

function readConfigLayerSync(filePath: string): ConfigLayer {
    try {
        const stats = fs.statSync(filePath);
        const fileContents = fs.readFileSync(filePath, 'utf8');
        return {
            signature: `${stats.mtimeMs}:${stats.size}`,
            parsed: parseConfigJson(fileContents, filePath)
        };
    }
    catch {
        return { signature: 'missing', parsed: null };
    }
}

/**
 * Malformed config must never break a git hook, so a parse failure degrades to defaults.
 */
function parseConfigJson(fileContents: string, filePath: string): unknown {
    try {
        return JSON.parse(fileContents);
    }
    catch {
        console.error(`AILoc2 probe config warning: ignoring malformed JSON at ${filePath}.`);
        return null;
    }
}

function readAttributionSection(layer: unknown): Record<string, unknown> | null {
    const attribution = readProperty(layer, 'attribution');
    return isRecord(attribution) ? attribution : null;
}

function readProperty(value: unknown, key: string): unknown {
    return isRecord(value) ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readAttributionMode(value: unknown): AttributionMode | null {
    return ATTRIBUTION_MODES.includes(value as AttributionMode) ? value as AttributionMode : null;
}

function readStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.filter((entry): entry is string => typeof entry === 'string');
}
