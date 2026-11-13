// Source-alias pass: runs `api/`'s own specs with `@librechat/api` (and its subpaths) aliased to
// `packages/api/src`, so changed source there gets coverage evidence from specs that only import
// the built package. Must run from the repo root with `cwd` set to the measured checkout: Jest's
// `rootDir` and this file's own requires resolve relative to `process.cwd()` at load time.
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const API = path.join(ROOT, 'api');
const SRC = path.join(ROOT, 'packages/api/src');
const SRC_SETUP = path.join(ROOT, 'packages/api/jest.setup.cjs');
const base = require(path.join(API, 'jest.config.js'));
// `~/` in api/jest.config.js always means api/; the resolver below makes it importer-aware instead.
// A base config may omit either field; treat an absent one as empty rather than crashing.
const {
  '~/(.*)': _tilde,
  '~/data/auth.json': _authMock,
  ...moduleNameMapper
} = base.moduleNameMapper ?? {};

// `roots` must include `SRC`, or related-test selection can never see `@librechat/api`'s alias
// target; `testPathIgnorePatterns` then stops its own specs from re-running as `api/` specs.
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

module.exports = {
  ...base,
  rootDir: ROOT,
  roots: [API, SRC],
  testPathIgnorePatterns: [
    ...(base.testPathIgnorePatterns ?? ['/node_modules/']),
    `^${escapeRegExp(SRC)}/`,
  ],
  setupFiles: [
    ...(base.setupFiles ?? []).map((file) => path.join(API, file)),
    ...(fs.existsSync(SRC_SETUP) ? [SRC_SETUP] : []),
  ],
  resolver: path.join(__dirname, 'jest.source.resolver.cjs'),
  moduleNameMapper: {
    ...Object.fromEntries(
      Object.entries(moduleNameMapper).map(([key, value]) => [
        key,
        typeof value === 'string' ? value.replace('<rootDir>', API) : value,
      ]),
    ),
    '^@librechat/api$': path.join(SRC, 'index.ts'),
    '^@librechat/api/telemetry$': path.join(SRC, 'telemetry.ts'),
    '^@librechat/api/credentials$': path.join(SRC, 'credentials.ts'),
  },
  coveragePathIgnorePatterns: ['/node_modules/'],
};
