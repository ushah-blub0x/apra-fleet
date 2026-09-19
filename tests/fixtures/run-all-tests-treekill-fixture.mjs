#!/usr/bin/env node
// Fixture for my-beads-db-0cd.21: stands in for a hung suite process that has
// itself spawned a grandchild, so a test can prove scripts/run-all-tests.mjs's
// timeout kill (my-beads-db-0cd.16) reaches BOTH levels, not just the
// immediate process run-all-tests.mjs spawned.
//
// This script is invoked in place of `npm`/`npm.cmd` via a PATH-prepended
// shim (see tests/run-all-tests-timeout-treekill.test.ts) so the real vitest
// and apra-fleet-se suites never actually run. On start it:
//   1. spawns a detached grandchild node process that idles forever,
//   2. records { childPid: <this process>, grandchildPid } as one JSON line
//      appended to the file named by RUN_ALL_TESTS_TEST_PIDFILE,
//   3. idles forever itself, producing no stdout -- run-all-tests.mjs's
//      timeout is the only thing that can end this, exactly like a real
//      hung test worker.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const pidFile = process.env.RUN_ALL_TESTS_TEST_PIDFILE;
if (!pidFile) {
    throw new Error('RUN_ALL_TESTS_TEST_PIDFILE env var not set');
}

const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
});
grandchild.unref();

fs.appendFileSync(
    pidFile,
    JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid }) + '\n',
);

// Never exits on its own.
setInterval(() => {}, 1_000_000);
