// Jest's moduleNameMapper is importer-blind, so `~/` cannot mean two directories at once. This
// resolver picks api/ or packages/api/src by the importing file's own directory.
const path = require('path');

module.exports = (request, options) => {
  if (!request.startsWith('~/')) return options.defaultResolver(request, options);
  const ROOT = process.cwd();
  const API = path.join(ROOT, 'api');
  const SRC = path.join(ROOT, 'packages/api/src');
  const inSrc = options.basedir === SRC || options.basedir.startsWith(SRC + path.sep);
  const target =
    !inSrc && request === '~/data/auth.json'
      ? path.join(API, '__mocks__/auth.mock.json')
      : path.join(inSrc ? SRC : API, request.slice(2));
  return options.defaultResolver(target, options);
};
