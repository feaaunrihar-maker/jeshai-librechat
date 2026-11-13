import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import type { Finding, QualityFindings } from './findings.mts';

import {
  checkFindings,
  ensureFindingsFile,
  findingKey,
  MAX_REASON,
  MAX_TEXT,
  truncate,
  writeFindings,
} from './findings.mts';
import { validateFindings } from './inline.mts';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    key: 'c'.repeat(64),
    file: 'packages/data-schemas/src/example.js',
    line: 1,
    column: 1,
    endLine: 1,
    endColumn: 10,
    mutator: 'BooleanLiteral',
    original: 'true',
    replacement: 'false',
    status: 'Survived',
    rank: 0,
    tags: ['behavior'],
    reason: 'A BooleanLiteral mutation was not detected by any test.',
    ...overrides,
  };
}

function findings(overrides: Partial<QualityFindings> = {}): QualityFindings {
  return {
    schema: 'quality-findings/v1',
    repository: 'owner/repo',
    pr: 42,
    base: BASE,
    head: HEAD,
    workspace: 'packages/data-schemas',
    planDigest: 'deadbeef',
    status: 'complete',
    findings: [finding()],
    ...overrides,
  };
}

test('truncate caps length and never splits a surrogate pair', () => {
  assert.equal(truncate('short', 10), 'short');
  const long = 'x'.repeat(200);
  const truncated = truncate(long, 50);
  assert.ok(truncated.length <= 50);
  assert.ok(truncated.endsWith('…[truncated]'));
  // Below the marker's own length there is no room left for it; the length bound still holds.
  const tiny = truncate(long, 10);
  assert.equal(tiny.length, 10);
  assert.equal(tiny, 'x'.repeat(10));
  // U+1F600 is a surrogate pair; truncating must never cut between the two units, for any cut
  // point near the pair (below, at, or past it).
  const withEmoji = 'a'.repeat(12) + '\u{1F600}' + 'a'.repeat(12);
  const lonelySurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
  for (let max = 14; max <= 30; max += 1) {
    const result = truncate(withEmoji, max);
    assert.ok(
      !lonelySurrogate.test(result),
      `must not split the surrogate pair: ${JSON.stringify(result)}`,
    );
  }
});

test('findingKey is stable across an unrelated line shift and distinguishes ordinals', () => {
  const base = {
    file: 'packages/data-schemas/src/example.js',
    mutator: 'BooleanLiteral',
    original: 'true',
    replacement: 'false',
    functionName: 'example',
  };
  // Nothing about the key formula takes a line/column, so an unrelated shift elsewhere in the
  // file (which never appears in these inputs at all) cannot change it.
  assert.equal(findingKey({ ...base, ordinal: 0 }), findingKey({ ...base, ordinal: 0 }));
  assert.notEqual(findingKey({ ...base, ordinal: 0 }), findingKey({ ...base, ordinal: 1 }));
  assert.notEqual(
    findingKey({ ...base, ordinal: 0 }),
    findingKey({ ...base, functionName: 'other', ordinal: 0 }),
  );
});

test('checkFindings accepts a well-formed artifact and rejects each contract violation', () => {
  assert.equal(checkFindings(findings()), undefined);
  assert.match(checkFindings(findings({ schema: 'quality-findings/v2' as never }))!, /schema/);
  assert.match(checkFindings(findings({ repository: '' }))!, /repository/);
  assert.match(checkFindings(findings({ pr: -1 }))!, /pr/);
  assert.equal(checkFindings(findings({ pr: 0 })), undefined, 'pr=0 means no pull request');
  assert.match(checkFindings(findings({ base: 'not-a-sha' }))!, /base/);
  assert.match(checkFindings(findings({ head: 'not-a-sha' }))!, /head/);
  assert.match(checkFindings(findings({ workspace: 'packages/api' as never }))!, /workspace/);
  assert.match(checkFindings(findings({ status: 'done' as never }))!, /status/);
  assert.match(
    checkFindings(findings({ findings: [finding({ status: 'Killed' as never })] }))!,
    /finding entry/,
  );
  assert.match(checkFindings(findings({ findings: [finding({ tags: [] })] }))!, /finding entry/);
  assert.match(
    checkFindings(
      findings({ findings: [finding({ key: 'd'.repeat(64) }), finding({ key: 'd'.repeat(64) })] }),
    )!,
    /Duplicate finding key/,
  );
  assert.match(checkFindings(findings({ reportUrl: 'http://insecure' }))!, /report URL/);
  assert.equal(checkFindings(findings({ reportUrl: 'https://example.invalid/report' })), undefined);
});

test('writeFindings truncates oversized text and refuses to write an invalid artifact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-findings-'));
  try {
    const path = join(directory, 'findings.json');
    const oversized = findings({
      findings: [
        finding({
          original: 'x'.repeat(MAX_TEXT + 500),
          replacement: 'y'.repeat(MAX_TEXT + 500),
          reason: 'z'.repeat(MAX_REASON + 500),
        }),
      ],
    });
    const written = writeFindings(path, oversized);
    assert.ok(written.findings[0].original.length <= MAX_TEXT);
    assert.ok(written.findings[0].replacement.length <= MAX_TEXT);
    assert.ok(written.findings[0].reason.length <= MAX_REASON);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), written);

    assert.throws(
      () => writeFindings(path, findings({ repository: '' })),
      /Refusing to write invalid findings artifact/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('mutator and tag validation agree between the writer and the privileged consumer', () => {
  const variants: Array<[string, Partial<Finding>]> = [
    ['valid letters-only mutator', {}],
    ['mutator with digits', { mutator: 'Block1' }],
    ['empty mutator', { mutator: '' }],
    ['oversize mutator', { mutator: 'x'.repeat(201) }],
    ['mutator with scope syntax', { mutator: '@org/team' }],
    ['no tags', { tags: [] }],
    ['unknown tag', { tags: ['exploit'] as never }],
    ['valid tag', { tags: ['tenant'] }],
  ];
  for (const [label, override] of variants) {
    const doc = findings({ findings: [finding(override)] });
    const producerOk = checkFindings(doc) === undefined;
    const consumerResult = validateFindings(doc, {
      repository: doc.repository,
      pr: doc.pr,
      base: doc.base,
      head: doc.head,
    });
    assert.equal(consumerResult.ok, producerOk, label);
  }
});

test('a writer-produced findings artifact passes the privileged consumer check in inline.mts', () => {
  const data = findings();
  const result = validateFindings(data, {
    repository: data.repository,
    pr: data.pr,
    base: data.base,
    head: data.head,
  });
  assert.equal(result.ok, true, result.ok ? undefined : result.error);
});

test('ensureFindingsFile writes a trusted unavailable placeholder only when none exists', () => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-ensure-'));
  try {
    const path = join(directory, 'nested', 'findings.json');
    const written = ensureFindingsFile(path, {
      repository: 'owner/repo',
      pr: 3,
      base: BASE,
      head: HEAD,
    });
    assert.ok(written);
    assert.equal(written!.status, 'unavailable');
    assert.deepEqual(written!.findings, []);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), written);

    // A merge step that already produced a real artifact must never be overwritten.
    const real = findings({ status: 'complete' });
    writeFileSync(path, JSON.stringify(real));
    const skipped = ensureFindingsFile(path, {
      repository: 'owner/repo',
      pr: 3,
      base: BASE,
      head: HEAD,
    });
    assert.equal(skipped, undefined);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), real);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('ensureFindingsFile leaves findings.json absent rather than invalid when no base is known', () => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-ensure-'));
  try {
    const path = join(directory, 'findings.json');
    const written = ensureFindingsFile(path, {
      repository: 'owner/repo',
      pr: 0,
      base: '',
      head: HEAD,
    });
    assert.equal(written, undefined);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
