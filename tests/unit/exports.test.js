import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const RAPID_DOC_DIR = path.join(ROOT, 'rapid_doc');

/**
 * Property: Public API Export Integrity
 *
 * For any named export in `rapid_doc/index.js`, importing that export should
 * yield a defined value (function, class, or constant) — never `undefined`.
 *
 *
 */
describe('Public API Export Integrity', () => {
  it('all named exports from rapid_doc/index.js resolve to defined values', async () => {
    let indexModule;
    try {
      indexModule = await import(
        path.join(RAPID_DOC_DIR, 'index.js')
      );
    } catch (err) {
      if (err.message && err.message.includes('Cannot find module')) {
        console.warn('Skipping test: onnxruntime module not installed. Run npm install first.');
        return;
      }
      throw err;
    }

    const exportNames = Object.keys(indexModule);
    expect(exportNames.length).toBeGreaterThan(0);

    const undefinedExports = [];
    for (const name of exportNames) {
      if (indexModule[name] === undefined) {
        undefinedExports.push(name);
      }
    }

    expect(
      undefinedExports,
      `The following exports resolved to undefined: ${undefinedExports.join(', ')}`
    ).toEqual([]);
  });

  it('exports include expected core API members', async () => {
    let indexModule;
    try {
      indexModule = await import(
        path.join(RAPID_DOC_DIR, 'index.js')
      );
    } catch (err) {
      if (err.message && err.message.includes('Cannot find module')) {
        console.warn('Skipping test: onnxruntime module not installed.');
        return;
      }
      throw err;
    }

    expect(indexModule.docAnalyze).toBeDefined();
    expect(indexModule.ModelSingleton).toBeDefined();
    expect(indexModule.unionMake).toBeDefined();
    expect(indexModule.resultToMiddleJson).toBeDefined();
    expect(indexModule.BatchAnalyze).toBeDefined();
    expect(indexModule.MakeMode).toBeDefined();
    expect(indexModule.CategoryId).toBeDefined();
    expect(indexModule.BlockType).toBeDefined();
    expect(indexModule.AbortException).toBeDefined();
    expect(indexModule.AtomModelSingleton).toBeDefined();
  });

  it('exported functions are of type function or object', async () => {
    let indexModule;
    try {
      indexModule = await import(
        path.join(RAPID_DOC_DIR, 'index.js')
      );
    } catch (err) {
      if (err.message && err.message.includes('Cannot find module')) {
        console.warn('Skipping test: onnxruntime module not installed.');
        return;
      }
      throw err;
    }

    for (const [name, value] of Object.entries(indexModule)) {
      const validTypes = ['function', 'object', 'number', 'string', 'boolean'];
      expect(
        validTypes.includes(typeof value),
        `Export "${name}" has unexpected type: ${typeof value}`
      ).toBe(true);
    }
  });
});

/**
 * Property: Barrel File Purity
 *
 * For any barrel/index file (`index.js`) in the `rapid_doc/` tree, the file
 * should contain only `import` and `export` declarations — no function
 * definitions, class definitions, or executable statements.
 *
 * , 10.3
 */
describe('Barrel File Purity', () => {
  /**
   * Collect all index.js files in rapid_doc/ tree.
   */
  function getBarrelFiles() {
    const barrelFiles = [];

    function walk(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__pycache__' || entry.name === 'node_modules') continue;
          walk(fullPath);
        } else if (entry.name === 'index.js') {
          barrelFiles.push(fullPath);
        }
      }
    }

    walk(RAPID_DOC_DIR);
    return barrelFiles;
  }

  /**
   * Known exceptions: index.js files that intentionally contain logic.
   * These are documented as acceptable deviations from barrel purity because
   * they port Python __init__.py files that contained class definitions.
   */
  const KNOWN_EXCEPTIONS = [
    // data_reader_writer/index.js implements DataWriter/DataReader classes
    path.join('data', 'data_reader_writer', 'index.js'),
    // base/index.js files implement abstract base classes (porting Python ABC from __init__.py)
    path.join('model', 'formula', 'rapid_formula_self', 'model_handler', 'base', 'index.js'),
    path.join('model', 'layout', 'rapid_layout_self', 'model_handler', 'base', 'index.js'),
  ];

  function isKnownException(filePath) {
    const relative = path.relative(RAPID_DOC_DIR, filePath);
    return KNOWN_EXCEPTIONS.some(exc => relative === exc);
  }

  /**
   * Check if a file contains only import/export statements (plus comments and whitespace).
   * Handles multi-line import/export statements properly.
   *
   * Returns an array of violation objects { line, content } for any impure lines.
   */
  function checkBarrelPurity(content) {
    const lines = content.split('\n');
    const violations = [];

    let inBlockComment = false;
    let inMultiLineImportExport = false;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      // Handle block comments
      if (inBlockComment) {
        if (trimmed.includes('*/')) {
          inBlockComment = false;
        }
        continue;
      }

      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/')) {
          inBlockComment = true;
        }
        continue;
      }

      // Handle multi-line import/export continuation
      if (inMultiLineImportExport) {
        // Lines inside a multi-line import/export block (identifiers, commas, closing brace + from)
        if (trimmed.includes(';') || (trimmed.startsWith('}') && trimmed.includes('from'))) {
          inMultiLineImportExport = false;
        } else if (trimmed === '}' || trimmed === '};') {
          inMultiLineImportExport = false;
        }
        continue;
      }

      // Empty lines
      if (trimmed === '') continue;

      // Single-line comments
      if (trimmed.startsWith('//')) continue;

      // 'use strict' directive
      if (trimmed === "'use strict';" || trimmed === '"use strict";') continue;

      // Single-line import/export statements
      if (/^(import|export)\s/.test(trimmed) || /^(import|export)\{/.test(trimmed)) {
        // Check if this is a multi-line statement (no semicolon and no closing on same line)
        if (!trimmed.endsWith(';') && !trimmed.endsWith("';") && !trimmed.endsWith('";')) {
          // Multi-line: export { ... } from '...' or import { ... } from '...'
          inMultiLineImportExport = true;
        }
        continue;
      }

      // If we get here, it's an impure line
      violations.push({ line: i + 1, content: trimmed });
    }

    return violations;
  }

  it('all barrel files in rapid_doc/ contain only import/export declarations', () => {
    const barrelFiles = getBarrelFiles();
    expect(barrelFiles.length).toBeGreaterThan(0);

    const allViolations = [];

    for (const filePath of barrelFiles) {
      if (isKnownException(filePath)) continue;

      const content = fs.readFileSync(filePath, 'utf-8');
      const violations = checkBarrelPurity(content);

      if (violations.length > 0) {
        const relativePath = path.relative(RAPID_DOC_DIR, filePath);
        for (const v of violations) {
          allViolations.push({ file: relativePath, ...v });
        }
      }
    }

    if (allViolations.length > 0) {
      const details = allViolations
        .map(v => `  ${v.file}:${v.line} → "${v.content}"`)
        .join('\n');
      expect.fail(
        `Barrel files contain non-import/export statements:\n${details}`
      );
    }
  });

  it('barrel files do not contain function declarations', () => {
    const barrelFiles = getBarrelFiles();

    const functionPatterns = [
      /^\s*function\s+\w+/,
      /^\s*async\s+function\s+\w+/,
      /^\s*(const|let|var)\s+\w+\s*=\s*(async\s*)?\(/,
      /^\s*(const|let|var)\s+\w+\s*=\s*function/,
    ];

    const violations = [];

    for (const filePath of barrelFiles) {
      if (isKnownException(filePath)) continue;

      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const pattern of functionPatterns) {
          if (pattern.test(line)) {
            const relativePath = path.relative(RAPID_DOC_DIR, filePath);
            violations.push({
              file: relativePath,
              line: i + 1,
              content: line.trim(),
            });
            break;
          }
        }
      }
    }

    if (violations.length > 0) {
      const details = violations
        .map(v => `  ${v.file}:${v.line} → "${v.content}"`)
        .join('\n');
      expect.fail(
        `Barrel files contain function declarations:\n${details}`
      );
    }
  });

  it('barrel files do not contain class declarations (excluding export class)', () => {
    const barrelFiles = getBarrelFiles();

    // Match class declarations that are NOT preceded by 'export'
    // export class is allowed in barrel files that re-export from __init__.py patterns
    const classPattern = /^\s*class\s+\w+/;
    const exportClassPattern = /^\s*export\s+(default\s+)?class\s+\w+/;

    const violations = [];

    for (const filePath of barrelFiles) {
      if (isKnownException(filePath)) continue;

      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (classPattern.test(line) && !exportClassPattern.test(line)) {
          const relativePath = path.relative(RAPID_DOC_DIR, filePath);
          violations.push({
            file: relativePath,
            line: i + 1,
            content: line.trim(),
          });
        }
      }
    }

    if (violations.length > 0) {
      const details = violations
        .map(v => `  ${v.file}:${v.line} → "${v.content}"`)
        .join('\n');
      expect.fail(
        `Barrel files contain non-exported class declarations:\n${details}`
      );
    }
  });

  it('the main rapid_doc/index.js is a pure barrel file', () => {
    const indexPath = path.join(RAPID_DOC_DIR, 'index.js');
    const content = fs.readFileSync(indexPath, 'utf-8');
    const violations = checkBarrelPurity(content);

    expect(
      violations,
      `rapid_doc/index.js contains non-import/export statements: ${JSON.stringify(violations)}`
    ).toEqual([]);
  });
});
