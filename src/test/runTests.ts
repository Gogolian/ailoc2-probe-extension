import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const testFiles = readdirSync(__dirname)
    .filter(fileName => fileName.endsWith('.test.js'))
    .sort()
    .map(fileName => join(__dirname, fileName));

if (testFiles.length === 0) {
    throw new Error(`No compiled test files found in ${__dirname}`);
}

const testProcess = spawnSync(
    process.execPath,
    ['--test', ...process.argv.slice(2), ...testFiles],
    { stdio: 'inherit' }
);

if (testProcess.error) {
    throw testProcess.error;
}

process.exitCode = testProcess.status ?? 1;
