import { Linter } from 'eslint';
import { readFileSync } from 'node:fs';
import sonarjs from 'eslint-plugin-sonarjs';
import { basename, resolve } from 'node:path';
import parser from '@typescript-eslint/parser';

import type { Rule } from 'eslint';

import type { CoverageState, FileCoverageResult } from './coverage.mts';
import type { ChangedFile } from './changes.mts';

import { changedLineCoverage, excerpt, groupRanges } from './coverage.mts';
import { git, overlaps } from './changes.mts';
import { changedRegions } from './lines.mts';
import { createReport } from '../crap.mts';

interface FunctionLocation {
  line: number;
  column: number;
  start: number;
  end: number;
  range: [number, number];
  nodeRange: [number, number];
  tokens: { start: number; end: number; value: string }[];
  cognitiveComplexity: number;
}

/** Run SonarJS itself. Zero is a measured score; a parse or rule failure is an error. */
export function cognitiveFunctions(file: string, source: string): FunctionLocation[] {
  const functions: FunctionLocation[] = [];
  const linter = new Linter();
  const messages = linter.verify(
    source,
    {
      files: ['**/*.{js,jsx,ts,tsx,mjs,mts,cjs,cts}'],
      languageOptions: {
        parser,
        parserOptions: { ecmaFeatures: { jsx: true } },
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      linterOptions: { noInlineConfig: true },
      plugins: {
        sonarjs,
        locations: {
          rules: {
            functions: {
              create(context: Rule.RuleContext) {
                return {
                  'FunctionDeclaration, FunctionExpression, ArrowFunctionExpression'(
                    node: Rule.Node,
                  ) {
                    if (!node.loc || !node.range) throw new Error('Missing function location');
                    const parent = node.parent;
                    const declaration =
                      parent?.type === 'VariableDeclarator' ||
                      parent?.type === 'MethodDefinition' ||
                      parent?.type === 'Property' ||
                      parent?.type === 'PropertyDefinition'
                        ? parent
                        : node;
                    if (!declaration.range || !declaration.loc)
                      throw new Error('Missing declaration location');
                    functions.push({
                      line: node.loc.start.line,
                      column: node.loc.start.column + 1,
                      start: declaration.loc.start.line,
                      end: node.loc.end.line,
                      range: [declaration.range[0], node.range[1]],
                      nodeRange: [node.range[0], node.range[1]],
                      tokens: context.sourceCode
                        .getTokens(declaration)
                        .filter((token) => token.range[1] <= node.range![1])
                        .map((token) => ({
                          start: token.range[0],
                          end: token.range[1],
                          value: JSON.stringify([token.type, token.value]),
                        })),
                      cognitiveComplexity: 0,
                    });
                  },
                };
              },
            },
          },
        },
      },
      rules: {
        'locations/functions': 'error',
        'sonarjs/cognitive-complexity': ['error', 0],
      },
    },
    { filename: basename(file) },
  );
  const sourceCode = linter.getSourceCode();
  for (const message of messages) {
    if (message.severity !== 2 && !message.fatal) continue;
    if (message.ruleId !== 'sonarjs/cognitive-complexity' || message.fatal) {
      throw new Error(`${file}:${message.line}: ${message.message}`);
    }
    const score = /Cognitive Complexity from (\d+) to/u.exec(message.message)?.[1];
    const offset = sourceCode.getIndexFromLoc({ line: message.line, column: message.column - 1 });
    const owner = functions
      .filter((fn) => fn.range[0] <= offset && offset < fn.range[1])
      .sort((a, b) => a.range[1] - a.range[0] - (b.range[1] - b.range[0]))[0];
    if (!owner || score === undefined)
      throw new Error(`Unrecognized SonarJS diagnostic: ${message.message}`);
    owner.cognitiveComplexity = Number(score);
  }
  return functions;
}

function children(fn: FunctionLocation, functions: FunctionLocation[]): FunctionLocation[] {
  return functions
    .filter(
      (child) =>
        child !== fn &&
        fn.nodeRange[0] <= child.nodeRange[0] &&
        child.nodeRange[1] <= fn.nodeRange[1],
    )
    .filter(
      (child, _index, nested) =>
        !nested.some(
          (parent) =>
            parent !== child &&
            parent.nodeRange[0] <= child.nodeRange[0] &&
            child.nodeRange[1] <= parent.nodeRange[1],
        ),
    );
}

/** Compare a function's own tokens. Editing a child does not select its unchanged parent. */
export function selectedFunctions(
  file: string,
  source: string,
  ranges: ChangedFile['ranges'],
  before?: string,
) {
  const functions = cognitiveFunctions(file, source);
  const fingerprint = (fn: FunctionLocation, all: FunctionLocation[]) => {
    const nested = children(fn, all);
    return fn.tokens
      .flatMap((token) => {
        const child = nested.find(
          (item) => item.nodeRange[0] <= token.start && token.end <= item.nodeRange[1],
        );
        return child ? (token.start === child.nodeRange[0] ? ['<function>'] : []) : [token.value];
      })
      .join('\n');
  };
  const prior = before === undefined ? [] : cognitiveFunctions(file, before);
  const remaining = new Map<string, number>();
  for (const fn of prior) {
    const key = fingerprint(fn, prior);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  // Match unchanged locations first, so inserting a duplicate does not select the old copy.
  const ordered = [...functions].sort(
    (a, b) => Number(overlaps(a.start, a.end, ranges)) - Number(overlaps(b.start, b.end, ranges)),
  );
  const selected = new Set<FunctionLocation>();
  for (const fn of ordered) {
    const key = fingerprint(fn, functions);
    const count = remaining.get(key) ?? 0;
    if (count) remaining.set(key, count - 1);
    else if (before !== undefined || overlaps(fn.start, fn.end, ranges)) selected.add(fn);
  }
  return functions.map((fn) => ({
    ...fn,
    selected: selected.has(fn),
    children: children(fn, functions),
  }));
}

/** Uses `oldFile` (set for a renamed file) so a fingerprint comparison against the base ref
 * reads the content the file actually had there, not a lookup under its new path. */
function previousSource(
  base: string | undefined,
  file: string,
  oldFile?: string,
): string | undefined {
  const path = oldFile ?? file;
  if (!base || !git(['ls-tree', '--name-only', '-z', base, '--', path])) return undefined;
  return git(['show', `${base}:${path}`]);
}

/** Changed-line selection for the mutation run. `selectedFunctions`' whole-function fingerprint
 * feeds only the risk/CRAP table; mutant placement and owner labeling come from `lines.mts`. */
export function mutationTarget(file: string, source: string, ranges: ChangedFile['ranges']) {
  const { mutate, functions, suppressions } = changedRegions(file, source, ranges);
  return { file, functions, mutate, suppressions };
}

/** Every changed file's mutation target, unfiltered: a comment-only change still carries its
 * suppressions even though it selects no mutant. */
export function allMutationTargets(files: ChangedFile[]) {
  return files.map(({ file, ranges }) => mutationTarget(file, readFileSync(file, 'utf8'), ranges));
}

export function mutationSelection(files: ChangedFile[]) {
  return allMutationTargets(files).filter(({ mutate }) => mutate.length);
}

export interface SuppressionAdvisory {
  file: string;
  line: number;
  text: string;
  problem: 'missing-reason' | 'all';
}

/** Flags a `// Stryker disable` comment naming `all`, or giving no reason, across every changed
 * file, including one whose only mutation target was filtered out of `mutationSelection`. */
export function suppressionAdvisory(
  targets: ReturnType<typeof allMutationTargets>,
): SuppressionAdvisory[] {
  return targets.flatMap(({ file, suppressions }) =>
    suppressions.map((item) => ({
      file,
      line: item.line,
      text: item.mutators,
      problem: (item.mutators.split(',').some((name) => name.trim().toLowerCase() === 'all')
        ? 'all'
        : 'missing-reason') as SuppressionAdvisory['problem'],
    })),
  );
}

export interface TestGapFile {
  file: string;
  state: CoverageState;
  /** Joined evidence source labels, e.g. "packages/api tests + api/ specs (source alias)". */
  scope: string;
  reasons: string[];
  gaps: { start: number; end: number; excerpt: string }[];
}

/** Changed-line coverage, from `changedRegions`' executable lines and each file's merged coverage
 * evidence. A non-`measured` file reports its reason instead of a (necessarily unreliable) gap list. */
export function testGapReport(files: ChangedFile[], results: FileCoverageResult[]): TestGapFile[] {
  const byFile = new Map(results.map((result) => [resolve(result.file), result]));
  return files.map(({ file, ranges }) => {
    const result = byFile.get(resolve(file));
    const source = readFileSync(file, 'utf8');
    const { lines } = changedRegions(file, source, ranges);
    const scope = result?.sources.join(' + ') ?? '';
    if (!result || result.state !== 'measured' || !result.entry) {
      return {
        file,
        state: result?.state ?? 'unavailable',
        scope,
        reasons: result?.reasons.length
          ? result.reasons
          : ['no coverage evidence computed for this file'],
        gaps: [],
      };
    }
    const { uncovered } = changedLineCoverage(lines, result.entry);
    const sourceLines = source.split(/\r\n|[\n\r\u2028\u2029]/u);
    const gaps = groupRanges(uncovered).map((range) => ({
      ...range,
      excerpt: excerpt(sourceLines, range),
    }));
    return { file, state: result.state, scope, reasons: result.reasons, gaps };
  });
}

export function riskReport(
  coverageFile: string,
  files: ChangedFile[],
  options: { base?: string; coverageResults?: FileCoverageResult[]; coverageScope?: string } = {},
) {
  const { base, coverageResults = [], coverageScope = '' } = options;
  const report = createReport(
    coverageFile,
    files.map(({ file }) => file),
    process.cwd(),
  );
  const selected = new Map(
    files.map(({ file, oldFile, ranges }) => [
      resolve(file),
      {
        ranges,
        functions: selectedFunctions(
          file,
          readFileSync(file, 'utf8'),
          ranges,
          previousSource(base, file, oldFile),
        ),
      },
    ]),
  );
  const functions = report.functions.flatMap((row) => {
    const selection = selected.get(resolve(row.file));
    const fn = selection?.functions.find(
      (item) => item.line === row.line && item.column === row.column,
    );
    if (!selection || !fn)
      throw new Error(`Function metrics disagree at ${row.file}:${row.line}:${row.column}`);
    if (!fn.selected) return [];
    return [{ ...row, cognitiveComplexity: fn.cognitiveComplexity }];
  });
  functions.sort(
    (a, b) => (b.crap ?? -1) - (a.crap ?? -1) || b.cognitiveComplexity - a.cognitiveComplexity,
  );
  return {
    ...report,
    cognitiveMetric: 'sonarjs/cognitive-complexity',
    functions,
    testGaps: testGapReport(files, coverageResults),
    coverageScope,
  };
}

export function riskMarkdown(report: ReturnType<typeof riskReport>): string {
  const cell = (value: string) => value.replaceAll('|', '\\|').replaceAll('\n', ' ');
  const gapLines = report.testGaps.flatMap((gap) => {
    const header = `### ${cell(gap.file)}${gap.scope ? ` (${cell(gap.scope)})` : ''}`;
    if (gap.state !== 'measured') {
      return [
        header,
        '',
        `Coverage ${gap.state}: ${gap.reasons.join('; ') || 'no reason given'}.`,
        '',
      ];
    }
    if (!gap.gaps.length) return [header, '', 'Every changed executable line is covered.', ''];
    return [
      header,
      '',
      ...gap.gaps.map((range) =>
        range.start === range.end
          ? `- L${range.start}: \`${range.excerpt}\``
          : `- L${range.start}-${range.end}: \`${range.excerpt}\``,
      ),
      '',
    ];
  });
  const rows = report.functions.map((row) =>
    [
      `${cell(row.file)}:${row.line}:${row.column}`,
      cell(row.function),
      row.complexity,
      row.cognitiveComplexity,
      row.statementCoverage === null ? 'N/A' : `${(row.statementCoverage * 100).toFixed(1)}%`,
      row.crap?.toFixed(2) ?? 'N/A',
    ].join(' | '),
  );
  return [
    '## Test gaps: changed lines without coverage',
    '',
    'Changed executable lines without an instrumented statement that ran. A file whose coverage',
    'is incomplete or unavailable lists its reason instead: an unreliable merge is not a test gap.',
    '',
    ...(gapLines.length ? gapLines : ['No changed files.', '']),
    '## Refactor hints (advisory)',
    '',
    'Complexity and CRAP for added or edited functions only; this is refactoring advice, not the',
    'test-gap signal above. CRAP uses ESLint classic complexity and whole-function statement',
    'coverage (nested functions own their statements), so a function can score well here while a',
    'line this change added is still uncovered above. Cognitive complexity uses SonarJS. N/A means',
    'coverage is unavailable, not zero risk.',
    '',
    '| Function location | Name | Cyclomatic | Cognitive | Statement coverage | CRAP |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
    ...rows.map((row) => `| ${row} |`),
    ...(rows.length ? [] : ['No added or edited functions.']),
    '',
    '## Coverage scope',
    '',
    `Coverage: ${report.coverageScope || 'no coverage evidence computed for this run'}.`,
    '',
  ].join('\n');
}
