import * as path from 'path';

export type ChatEditingUriLike = {
    scheme: string;
    fsPath?: string;
    path?: string;
    query?: string;
};

export function isChatEditingUriScheme(scheme: string): boolean {
    return scheme === 'chat-editing-text-model'
        || scheme === 'chat-editing-snapshot-text-model';
}

export function getChatEditingTargetFsPath(uri: ChatEditingUriLike, fileName: string | undefined): string | null {
    if (!isChatEditingUriScheme(uri.scheme)) {
        return null;
    }

    for (const candidate of collectChatEditingPathCandidates(uri, fileName)) {
        const normalized = normalizeCandidateFsPath(candidate);
        if (normalized) {
            return normalized;
        }
    }

    return null;
}

function collectChatEditingPathCandidates(uri: ChatEditingUriLike, fileName: string | undefined): string[] {
    return [
        fileName ?? '',
        uri.fsPath ?? '',
        uri.path ?? '',
        stripUriSchemePrefix(fileName ?? ''),
        getPathFromSnapshotQuery(uri.query)
    ].filter((candidate) => candidate.length > 0);
}

function normalizeCandidateFsPath(candidate: string): string | null {
    const withoutScheme = stripUriSchemePrefix(candidate);
    const windowsPath = normalizeWindowsUriPath(withoutScheme);
    if (windowsPath) {
        return windowsPath;
    }

    if (path.isAbsolute(withoutScheme)) {
        return path.normalize(withoutScheme);
    }

    return null;
}

function stripUriSchemePrefix(candidate: string): string {
    return candidate.replace(/^[a-z][a-z0-9+.-]*:(?=\/)/iu, '');
}

function normalizeWindowsUriPath(candidate: string): string | null {
    const match = /^\/?([a-zA-Z]:)(?:\/|\\)?(.*)$/u.exec(candidate);
    if (!match) {
        return null;
    }

    const rest = match[2].replace(/[\\/]+/gu, path.sep);
    return path.normalize(rest ? `${match[1]}${path.sep}${rest}` : match[1]);
}

function getPathFromSnapshotQuery(query: string | undefined): string {
    if (!query) {
        return '';
    }

    try {
        const parsed = JSON.parse(query) as { path?: unknown };
        return typeof parsed.path === 'string' ? parsed.path : '';
    }
    catch {
        return '';
    }
}
