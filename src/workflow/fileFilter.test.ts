import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shouldIgnoreFile, filterReviewableFiles } from './fileFilter.js';

describe('shouldIgnoreFile', () => {
  test('ignores known lockfiles regardless of directory', () => {
    assert.equal(shouldIgnoreFile('package-lock.json'), true);
    assert.equal(shouldIgnoreFile('packages/api/package-lock.json'), true);
    assert.equal(shouldIgnoreFile('yarn.lock'), true);
    assert.equal(shouldIgnoreFile('pnpm-lock.yaml'), true);
  });

  test('ignores files under node_modules/dist/build/generated at any depth', () => {
    assert.equal(shouldIgnoreFile('node_modules/left-pad/index.js'), true);
    assert.equal(shouldIgnoreFile('packages/api/node_modules/x/index.js'), true);
    assert.equal(shouldIgnoreFile('dist/bundle.js'), true);
    assert.equal(shouldIgnoreFile('server/build/main.js'), true);
    assert.equal(shouldIgnoreFile('src/generated/api.ts'), true);
  });

  test('ignores common generated-file naming conventions', () => {
    assert.equal(shouldIgnoreFile('vendor.min.js'), true);
    assert.equal(shouldIgnoreFile('styles.min.css'), true);
    assert.equal(shouldIgnoreFile('api.generated.ts'), true);
    assert.equal(shouldIgnoreFile('service.pb.go'), true);
    assert.equal(shouldIgnoreFile('models_pb2.py'), true);
  });

  test('ignores binary file extensions', () => {
    assert.equal(shouldIgnoreFile('logo.png'), true);
    assert.equal(shouldIgnoreFile('font.woff2'), true);
    assert.equal(shouldIgnoreFile('archive.zip'), true);
    assert.equal(shouldIgnoreFile('app.exe'), true);
    assert.equal(shouldIgnoreFile('report.pdf'), true);
  });

  test('does not ignore ordinary source files', () => {
    assert.equal(shouldIgnoreFile('src/index.ts'), false);
    assert.equal(shouldIgnoreFile('src/components/Button.tsx'), false);
    assert.equal(shouldIgnoreFile('README.md'), false);
    assert.equal(shouldIgnoreFile('server/routes/orders.js'), false);
  });

  test('does not false-positive on filenames merely containing an ignored word as a substring', () => {
    // "distinct-values.ts" contains "dist" as a substring but not as a path segment.
    assert.equal(shouldIgnoreFile('src/utils/distinct-values.ts'), false);
    assert.equal(shouldIgnoreFile('src/builder.ts'), false);
  });

  test('handles backslash path separators the same as forward slashes', () => {
    assert.equal(shouldIgnoreFile('node_modules\\left-pad\\index.js'), true);
  });
});

describe('filterReviewableFiles', () => {
  test('keeps only files that are not ignored', () => {
    const files = [
      { filename: 'src/index.ts' },
      { filename: 'package-lock.json' },
      { filename: 'dist/bundle.js' },
      { filename: 'src/utils.ts' },
    ];
    const result = filterReviewableFiles(files);
    assert.deepEqual(result.map((f) => f.filename), ['src/index.ts', 'src/utils.ts']);
  });
});
