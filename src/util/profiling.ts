import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';

const PROFILE_ENVIRONMENT_VARIABLE = 'AILOC2_PROFILE';
const PROFILE_FILE_NAME = 'performance.jsonl';

export type ProfileDetails = Record<string, boolean | number | string | null>;

type ProfileEvent = {
    timestamp: string;
    operation: string;
    durationMs: number;
    success: boolean;
    details?: ProfileDetails;
};

export function isProfilingEnabled(): boolean {
    const configuredValue = process.env[PROFILE_ENVIRONMENT_VARIABLE]?.trim().toLowerCase();
    return configuredValue === '1' || configuredValue === 'true';
}

export async function profileOperation<T>(
    repoRoot: string,
    operation: string,
    details: ProfileDetails,
    action: () => Promise<T>
): Promise<T> {
    if (!isProfilingEnabled()) {
        return action();
    }

    const startedAt = performance.now();
    try {
        const result = await action();
        await appendProfileEvent(repoRoot, {
            timestamp: new Date().toISOString(),
            operation,
            durationMs: roundDuration(performance.now() - startedAt),
            success: true,
            details
        });
        return result;
    }
    catch (error) {
        await appendProfileEvent(repoRoot, {
            timestamp: new Date().toISOString(),
            operation,
            durationMs: roundDuration(performance.now() - startedAt),
            success: false,
            details
        });
        throw error;
    }
}

async function appendProfileEvent(repoRoot: string, event: ProfileEvent): Promise<void> {
    try {
        const metricsRoot = path.join(repoRoot, '.ailoc2-metrics');
        await fs.promises.mkdir(metricsRoot, { recursive: true });
        await fs.promises.appendFile(
            path.join(metricsRoot, PROFILE_FILE_NAME),
            `${JSON.stringify(event)}\n`,
            'utf8'
        );
    }
    catch {
        // Profiling must never affect Git hook behavior.
    }
}

function roundDuration(durationMs: number): number {
    return Math.round(durationMs * 100) / 100;
}
