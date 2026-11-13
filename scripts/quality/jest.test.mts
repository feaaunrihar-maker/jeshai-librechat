import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { resolveAliasBudgetMinutes, runAliasCoverage } from './jest.mts';

test('resolveAliasBudgetMinutes defaults, accepts the valid range, and rejects everything else', () => {
  assert.equal(resolveAliasBudgetMinutes(undefined), 20);
  assert.equal(resolveAliasBudgetMinutes(''), 20);
  assert.equal(resolveAliasBudgetMinutes('1'), 1);
  assert.equal(resolveAliasBudgetMinutes('25'), 25);
  for (const invalid of ['0', '26', '-5', '12.5', 'abc']) {
    assert.throws(
      () => resolveAliasBudgetMinutes(invalid),
      /QUALITY_ALIAS_BUDGET_MINUTES must be an integer from 1 to 25/u,
      `expected ${JSON.stringify(invalid)} to be rejected`,
    );
  }
});

function fixture(directory: string, body: string): string {
  const script = join(directory, 'fixture-jest.cjs');
  writeFileSync(script, body);
  return script;
}

test('a completed alias pass returns the parsed results and coverage', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-alias-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'out');
  const jestBin = fixture(
    directory,
    `const fs = require('node:fs');
     fs.mkdirSync(${JSON.stringify(output)}, { recursive: true });
     fs.writeFileSync(${JSON.stringify(join(output, 'tests.json'))}, JSON.stringify({ testResults: [] }));
     fs.writeFileSync(${JSON.stringify(join(output, 'coverage-final.json'))}, JSON.stringify({ '/f.ts': { hash: 'x' } }));`,
  );
  const outcome = await runAliasCoverage({
    config: 'jest.config.js',
    cwd: directory,
    jestBin,
    tests: [],
    collectFrom: [],
    output,
    env: process.env,
    budgetMinutes: 1,
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.ok && outcome.value.coverage, { '/f.ts': { hash: 'x' } });
});

test('a pass that exceeds its budget is killed and reported as a timeout, not thrown', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-alias-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'out');
  // Never writes a results file; the parent must kill it instead of waiting forever.
  const jestBin = fixture(directory, 'setInterval(() => {}, 1000);');
  const outcome = await runAliasCoverage({
    config: 'jest.config.js',
    cwd: directory,
    jestBin,
    tests: [],
    collectFrom: [],
    output,
    env: process.env,
    budgetMinutes: 0.001,
  });
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.error.code, 'timeout');
  assert.match(!outcome.ok ? outcome.error.message : '', /exceeded 0\.001 min budget/u);
});

test('a crashing pass with no results file is reported as a failure, not thrown', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-alias-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'out');
  const jestBin = fixture(directory, 'process.exitCode = 1;');
  const outcome = await runAliasCoverage({
    config: 'jest.config.js',
    cwd: directory,
    jestBin,
    tests: [],
    collectFrom: [],
    output,
    env: process.env,
    budgetMinutes: 1,
  });
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.error.code, 'crashed');
  assert.match(!outcome.ok ? outcome.error.message : '', /crashed:/u);
});

test('a clean exit that still produces no results file is reported as a failure, not thrown', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-alias-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'out');
  mkdirSync(output, { recursive: true });
  const jestBin = fixture(directory, '');
  const outcome = await runAliasCoverage({
    config: 'jest.config.js',
    cwd: directory,
    jestBin,
    tests: [],
    collectFrom: [],
    output,
    env: process.env,
    budgetMinutes: 1,
  });
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.error.code, 'crashed');
  assert.equal(existsSync(join(output, 'tests.json')), false);
});
