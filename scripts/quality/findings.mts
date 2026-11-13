import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

/** The mutation-summary job's output; `inline.mts` validates it independently of this writer. */
export type Tag = 'authorization' | 'tenant' | 'credentials' | 'data-loss' | 'behavior';

export interface Finding {
  key: string;
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  mutator: string;
  original: string;
  replacement: string;
  status: 'Survived';
  rank: number;
  tags: Tag[];
  reason: string;
}

export interface QualityFindings {
  schema: 'quality-findings/v1';
  repository: string;
  pr: number;
  base: string;
  head: string;
  workspace: 'packages/data-schemas';
  planDigest: string;
  status: 'complete' | 'partial' | 'unavailable';
  findings: Finding[];
  reportUrl?: string;
}

export const MAX_TEXT = 2000;
export const MAX_REASON = 500;
const MAX_FINDINGS = 2000;
const TRUNCATION_MARKER = '…[truncated]';
const HEX40 = /^[a-f0-9]{40}$/u;
const HEX64 = /^[a-f0-9]{64}$/u;
// Empty matches too: an 'unavailable' artifact carries no plan to digest.
const HEX = /^[a-f0-9]*$/u;
const MUTATOR = /^[A-Za-z]{1,200}$/u;
const TAGS = new Set<Tag>(['authorization', 'tenant', 'credentials', 'data-loss', 'behavior']);

function isHighSurrogate(value: string, index: number): boolean {
  const code = value.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff;
}

/** Truncates to at most `max` UTF-16 units, never splitting a surrogate pair. Below the marker's
 * own length, the length bound still holds, just with no room left for the marker. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= TRUNCATION_MARKER.length) {
    let end = Math.max(0, max);
    if (end > 0 && isHighSurrogate(value, end - 1)) end -= 1;
    return value.slice(0, end);
  }
  let end = max - TRUNCATION_MARKER.length;
  if (end > 0 && isHighSurrogate(value, end - 1)) end -= 1;
  return value.slice(0, end) + TRUNCATION_MARKER;
}

/** Position-independent; identical (file, mutator, original, replacement, enclosing function)
 * tuples are distinguished only by the caller-chosen `ordinal`. */
export function findingKey(input: {
  file: string;
  mutator: string;
  original: string;
  replacement: string;
  functionName: string;
  ordinal: number;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.file,
        input.mutator,
        input.original,
        input.replacement,
        input.functionName,
        input.ordinal,
      ]),
    )
    .digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function isSafePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 500 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.split('/').includes('..')
  );
}

function isValidFinding(value: unknown): value is Finding {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.key === 'string' &&
    HEX64.test(value.key) &&
    isSafePath(value.file) &&
    isInteger(value.line, 1, 10_000_000) &&
    isInteger(value.column, 1, 10_000_000) &&
    isInteger(value.endLine, value.line as number, 10_000_000) &&
    isInteger(value.endColumn, 1, 10_000_000) &&
    typeof value.mutator === 'string' &&
    MUTATOR.test(value.mutator) &&
    typeof value.original === 'string' &&
    value.original.length <= MAX_TEXT &&
    typeof value.replacement === 'string' &&
    value.replacement.length <= MAX_TEXT &&
    value.status === 'Survived' &&
    isInteger(value.rank, 0, 1_000_000) &&
    Array.isArray(value.tags) &&
    value.tags.length > 0 &&
    value.tags.every((tag) => TAGS.has(tag as Tag)) &&
    typeof value.reason === 'string' &&
    value.reason.length > 0 &&
    value.reason.length <= MAX_REASON
  );
}

/** Checks the exact contract this writer promises, mirroring the privileged consumer's own
 * validation in `inline.mts` without importing it. */
export function checkFindings(data: QualityFindings): string | undefined {
  if (data.schema !== 'quality-findings/v1') return 'Unsupported findings schema';
  if (typeof data.repository !== 'string' || !data.repository) return 'Invalid repository';
  // 0 means "no pull request" (a workflow_dispatch run); a real request always has a positive pr.
  if (!isInteger(data.pr, 0, 1_000_000_000)) return 'Invalid pr';
  if (!HEX40.test(data.base)) return 'Invalid base commit';
  if (!HEX40.test(data.head)) return 'Invalid head commit';
  if (data.workspace !== 'packages/data-schemas') return 'Unsupported findings workspace';
  if (!HEX.test(data.planDigest) || data.planDigest.length > 128) return 'Invalid plan digest';
  if (!['complete', 'partial', 'unavailable'].includes(data.status))
    return 'Invalid findings status';
  if (!Array.isArray(data.findings) || data.findings.length > MAX_FINDINGS)
    return 'Invalid findings list';
  if (!data.findings.every(isValidFinding)) return 'Invalid finding entry';
  if (
    data.reportUrl !== undefined &&
    (data.reportUrl.length > 500 || !/^https:\/\//u.test(data.reportUrl))
  )
    return 'Invalid report URL';
  const keys = new Set<string>();
  for (const finding of data.findings) {
    if (keys.has(finding.key)) return `Duplicate finding key: ${finding.key}`;
    keys.add(finding.key);
  }
  return undefined;
}

/** Applies the text caps, validates the result against this module's own contract, and writes
 * it. Throws rather than publish an artifact that would fail the privileged consumer's checks. */
export function writeFindings(path: string, data: QualityFindings): QualityFindings {
  const capped: QualityFindings = {
    ...data,
    findings: data.findings.map((finding) => ({
      ...finding,
      original: truncate(finding.original, MAX_TEXT),
      replacement: truncate(finding.replacement, MAX_TEXT),
      reason: truncate(finding.reason, MAX_REASON),
    })),
  };
  const problem = checkFindings(capped);
  if (problem) throw new Error(`Refusing to write invalid findings artifact: ${problem}`);
  writeFileSync(path, JSON.stringify(capped, null, 2));
  return capped;
}

/** Last-resort safety net for the upload step: writes a placeholder `findings.json` when a
 * skipped or failed merge left none. Best effort: an unresolved base leaves the file absent. */
export function ensureFindingsFile(
  path: string,
  meta: { repository: string; pr: number; base: string; head: string },
): QualityFindings | undefined {
  if (existsSync(path)) return undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    return writeFindings(path, {
      schema: 'quality-findings/v1',
      repository: meta.repository,
      pr: meta.pr,
      base: meta.base,
      head: meta.head,
      workspace: 'packages/data-schemas',
      planDigest: '',
      status: 'unavailable',
      findings: [],
    });
  } catch {
    return undefined;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      output: { type: 'string' },
      repository: { type: 'string' },
      pr: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
    },
  });
  if (!values.output || !values.repository || !values.pr || !values.head)
    throw new Error('Expected --output, --repository, --pr and --head');
  const pr = Number(values.pr);
  // 0 means "no pull request" (a manual workflow_dispatch run with nothing to comment on).
  if (!Number.isInteger(pr) || pr < 0) throw new Error('--pr must be a non-negative integer');
  const wrote = ensureFindingsFile(values.output, {
    repository: values.repository,
    pr,
    base: values.base || '',
    head: values.head,
  });
  console.log(
    wrote
      ? `Wrote a placeholder 'unavailable' findings.json at ${values.output}.`
      : `${values.output} already exists or could not be written; left it as-is.`,
  );
}
