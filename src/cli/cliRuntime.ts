import * as path from 'path';

import { toErrorMessage } from '../util/errors';

export function resolveRepoRootArgument(repoRootArgument: string | undefined): string {
    return path.resolve(process.cwd(), repoRootArgument ?? '.');
}

export function runCli(cliName: string, main: () => Promise<number>): void {
    void main()
        .then((exitCode) => {
            process.exitCode = exitCode;
        })
        .catch((error) => {
            console.error(`${cliName} failed: ${toErrorMessage(error)}`);
            process.exitCode = 1;
        });
}
