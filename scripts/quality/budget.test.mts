import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import {
  parseProgressLines,
  resolveMutationBudgetMinutes,
  runWithinBudget,
  wasAlreadyComplete,
} from './budget.mts';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls until `pid` is gone or `boundMs` elapses, instead of a single fixed-delay check. */
async function waitUntilDead(pid: number, boundMs: number): Promise<boolean> {
  const deadline = Date.now() + boundMs;
  let alive = isAlive(pid);
  while (alive && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    alive = isAlive(pid);
  }
  return alive;
}

/** Polls until `path` exists and returns its contents, instead of a fixed delay that can be too
 * short under a loaded machine (e.g. the full suite running in parallel). */
async function waitForFile(path: string, boundMs: number): Promise<string> {
  const deadline = Date.now() + boundMs;
  while (Date.now() < deadline) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
  return readFileSync(path, 'utf8');
}

test('resolveMutationBudgetMinutes defaults, accepts the valid range, and rejects everything else', () => {
  assert.equal(resolveMutationBudgetMinutes(undefined), 60);
  assert.equal(resolveMutationBudgetMinutes(''), 60);
  assert.equal(resolveMutationBudgetMinutes('1'), 1);
  assert.equal(resolveMutationBudgetMinutes('230'), 230);
  for (const invalid of ['0', '231', '-5', '12.5', 'abc']) {
    assert.throws(
      () => resolveMutationBudgetMinutes(invalid),
      /QUALITY_MUTATION_BUDGET_MINUTES must be an integer from 1 to 230/,
      `expected ${JSON.stringify(invalid)} to be rejected`,
    );
  }
});

test('a child finishing within budget is not treated as timed out', async () => {
  const result = await runWithinBudget(process.execPath, ['-e', '0'], 30_000);
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
});

test('a child exceeding the budget is signalled, and its own child process dies with it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-budget-'));
  const heartbeat = join(directory, 'heartbeat');
  const grandchildScript = join(directory, 'grandchild.js');
  const parentScript = join(directory, 'parent.js');
  // The parent spawns an undetached grandchild that writes a heartbeat file every tick, so this
  // test can tell whether killing the parent's process *group* actually reaches it too, not just
  // the direct child Node spawned.
  writeFileSync(
    grandchildScript,
    `const fs = require('node:fs');
     setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())), 20);`,
  );
  writeFileSync(
    parentScript,
    `require('node:child_process').spawn(process.execPath, [${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });
     setInterval(() => {}, 1000);`,
  );
  try {
    const result = await runWithinBudget(process.execPath, [parentScript], 400);
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null, 'a signalled process has no normal exit code');
    // Give the grandchild a moment to have written its last heartbeat, then confirm it stops.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    const lastSeen = Number(readFileSync(heartbeat, 'utf8'));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    const stillSeen = Number(readFileSync(heartbeat, 'utf8'));
    assert.equal(stillSeen, lastSeen, 'the grandchild must stop writing once the group is killed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a grandchild that ignores SIGTERM is still SIGKILLed after the grace period, even though the direct child already exited', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-budget-'));
  const pidFile = join(directory, 'grandchild.pid');
  const grandchildScript = join(directory, 'grandchild.js');
  const parentScript = join(directory, 'parent.js');
  // The direct child has no handler of its own, so the deadline's SIGTERM reaps it almost
  // immediately; only the grandchild below needs to ignore SIGTERM for this test to exercise the
  // grace-period SIGKILL rather than the plain SIGTERM path the test above already covers.
  writeFileSync(
    grandchildScript,
    `const fs = require('node:fs');
     fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
     process.on('SIGTERM', () => {});
     setInterval(() => {}, 1000);`,
  );
  writeFileSync(
    parentScript,
    `require('node:child_process').spawn(process.execPath, [${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });
     setInterval(() => {}, 1000);`,
  );
  try {
    const result = await runWithinBudget(process.execPath, [parentScript], 150, { graceMs: 200 });
    assert.equal(result.timedOut, true);
    const grandchildPid = Number(readFileSync(pidFile, 'utf8'));
    assert.equal(
      await waitUntilDead(grandchildPid, 1000),
      false,
      'the SIGTERM-ignoring grandchild must not survive the grace period',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runWithinBudget settles a bare top-level await, not just this test's own busier host process, once a lingering grandchild is SIGKILLed", () => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-budget-toplevel-'));
  const grandchildScript = join(directory, 'grandchild.js');
  const parentScript = join(directory, 'parent.js');
  const wrapperScript = join(directory, 'wrapper.mts');
  // The direct child has no SIGTERM handler, so it dies almost immediately, while the grandchild
  // ignores SIGTERM; a standalone top-level-await script has no other pending work left once that
  // direct child is gone, so an unref'd grace-period poll here let Node exit before it resolved.
  writeFileSync(
    grandchildScript,
    `process.on('SIGTERM', () => {});
     setInterval(() => {}, 1000);`,
  );
  writeFileSync(
    parentScript,
    `require('node:child_process').spawn(process.execPath, [${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });
     setInterval(() => {}, 1000);`,
  );
  const budgetModule = pathToFileURL(resolve('scripts/quality/budget.mts')).href;
  writeFileSync(
    wrapperScript,
    `import { runWithinBudget } from ${JSON.stringify(budgetModule)};
     const result = await runWithinBudget(${JSON.stringify(process.execPath)}, [${JSON.stringify(parentScript)}], 150, { graceMs: 200 });
     console.log(JSON.stringify(result));`,
  );
  try {
    const run = spawnSync(process.execPath, [wrapperScript], { encoding: 'utf8', timeout: 5000 });
    assert.equal(
      run.status,
      0,
      `expected a clean exit, got status=${run.status} stderr=${run.stderr}`,
    );
    assert.doesNotMatch(run.stderr, /Unsettled Top-Level Await/u);
    assert.equal(JSON.parse(run.stdout.trim()).timedOut, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a SIGTERM/SIGINT the orchestrator itself receives is forwarded to the detached group, then it exits', async () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const directory = mkdtempSync(join(tmpdir(), 'quality-budget-forward-'));
    const pidFile = join(directory, 'grandchild.pid');
    const grandchildScript = join(directory, 'grandchild.js');
    const parentScript = join(directory, 'parent.js');
    const wrapperScript = join(directory, 'wrapper.mts');
    writeFileSync(
      grandchildScript,
      `const fs = require('node:fs');
       fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
       setInterval(() => {}, 1000);`,
    );
    writeFileSync(
      parentScript,
      `require('node:child_process').spawn(process.execPath, [${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });
       setInterval(() => {}, 1000);`,
    );
    // The orchestrator itself must receive the signal, which means running `runWithinBudget` in
    // its own process rather than this test's; this wrapper does that, with a budget far longer
    // than the test, so only the forwarded signal (never the deadline) can end the run.
    const budgetModule = pathToFileURL(resolve('scripts/quality/budget.mts')).href;
    writeFileSync(
      wrapperScript,
      `import { runWithinBudget } from ${JSON.stringify(budgetModule)};
       await runWithinBudget(${JSON.stringify(process.execPath)}, [${JSON.stringify(parentScript)}], 60_000);`,
    );
    const wrapper = spawn(process.execPath, [wrapperScript], { stdio: 'ignore' });
    try {
      // Wait for the wrapper to spawn its own child and grandchild before signalling it, rather
      // than a fixed delay that a loaded machine (e.g. the full suite running in parallel) can
      // outlast.
      const grandchildPid = Number(await waitForFile(pidFile, 5000));
      process.kill(wrapper.pid!, signal);
      assert.equal(
        await waitUntilDead(wrapper.pid!, 2000),
        false,
        `the wrapper must exit after forwarding ${signal}`,
      );
      assert.equal(
        await waitUntilDead(grandchildPid, 2000),
        false,
        `the grandchild must not survive the forwarded ${signal}`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('parseProgressLines skips only a malformed final line; an earlier malformed line is a tool error', () => {
  const result = { id: '1', status: 'Killed' };
  const good = `${JSON.stringify(result)}\n`;
  assert.deepEqual(parseProgressLines(good + '{"truncat'), [result]);
  assert.deepEqual(parseProgressLines(good), [result]);
  assert.deepEqual(parseProgressLines(''), []);
  assert.throws(() => parseProgressLines('{"truncat\n' + good), /Unexpected|JSON/);
});

test('wasAlreadyComplete only reports true for a well-formed completion record marked complete', () => {
  assert.equal(wasAlreadyComplete(undefined), false);
  assert.equal(wasAlreadyComplete('not json'), false);
  assert.equal(wasAlreadyComplete('null'), false);
  assert.equal(wasAlreadyComplete(JSON.stringify({ complete: false })), false);
  assert.equal(wasAlreadyComplete(JSON.stringify({ complete: true })), true);
});
