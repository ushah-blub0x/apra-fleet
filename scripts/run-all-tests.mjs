#!/usr/bin/env node
// Runs vitest and the apra-fleet-se workspace's own test suite unconditionally
// -- unlike `vitest run && npm test --workspace=...`, a failure (including a
// flaky, unrelated one) in the first suite no longer silently skips the
// second suite entirely. Exits non-zero if either suite failed.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// How much of each suite's output to echo. The full log stays on disk.
const TAIL_LINES = 200;

const suites = [
    { name: 'vitest', cmd: npmCmd, args: ['exec', '--', 'vitest', 'run'] },
    { name: 'apra-fleet-se', cmd: npmCmd, args: ['test', '--workspace=@apralabs/apra-fleet-se'] },
];

let failed = false;
for (const suite of suites) {
    console.log(`\n> running ${suite.name} suite...\n`);
    // shell: true is required on Windows: Node refuses to spawnSync a
    // .cmd/.bat file directly (EINVAL) since the CVE-2024-27980 fix -- npm
    // ships as npm.cmd there. Harmless on POSIX where cmd is plain 'npm'.
    // Suite output goes to a real FILE DESCRIPTOR, not an inherited or piped
    // stdio. Under fleet-sprint the process tree runs with no terminal and a
    // consumer that may not drain, and a child writing more than the OS pipe
    // buffer then blocks on write forever: spawnSync never returns, the
    // suite sits at ~0% CPU until the dispatch timeout kills it, and the
    // children are orphaned. Measured against a deliberately non-draining
    // consumer: stdio:'inherit' deadlocks, and stdio:'pipe' ALSO deadlocks
    // (it only moves the block to this process writing the captured buffer
    // back out). Writing to a file descriptor never blocks on a reader, so
    // it is the only variant that completes.
    const logPath = path.join(os.tmpdir(), `apra-fleet-tests-${suite.name}-${process.pid}.log`);
    const fd = fs.openSync(logPath, 'w');
    let result;
    try {
        result = spawnSync(suite.cmd, suite.args, { stdio: ['ignore', fd, fd], shell: true });
    } finally {
        fs.closeSync(fd);
    }

    // Echo a BOUNDED tail rather than the whole log: the full output is on
    // disk either way, and an unbounded write here would re-introduce the
    // very blocking this function exists to avoid.
    const output = fs.readFileSync(logPath, 'utf8');
    const tail = output.split('\n').slice(-TAIL_LINES).join('\n');
    console.log(tail);
    console.log(`> ${suite.name}: full output at ${logPath}`);

    if (result.error) {
        failed = true;
        console.error(`\n> ${suite.name} suite could not be spawned: ${result.error.message}\n`);
        continue;
    }
    if (result.status !== 0) {
        failed = true;
        console.error(`\n> ${suite.name} suite FAILED (exit ${result.status})\n`);
    }
}

process.exit(failed ? 1 : 0);
