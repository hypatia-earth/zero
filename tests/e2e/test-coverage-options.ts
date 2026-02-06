#!/usr/bin/env npx ts-node
/**
 * E2E Test Coverage Report
 *
 * Reads options.schema.ts and reports which options have tests defined.
 *
 * Usage:
 *   npx ts-node scripts/test-coverage.ts
 *   npx ts-node scripts/test-coverage.ts --missing   # Only show untested
 */

import { optionsSchema } from '../../src/schemas/options.schema';

interface CoverageResult {
  path: string;
  label: string;
  test: string | null;
}

function extractOptions(schema: any, path: string = ''): CoverageResult[] {
  const results: CoverageResult[] = [];

  if (schema._def?.typeName === 'ZodObject') {
    const shape = schema._def.shape();
    for (const [key, value] of Object.entries(shape) as [string, any][]) {
      const fullPath = path ? `${path}.${key}` : key;

      // Check if this field has metadata (is an option)
      if (value._meta) {
        results.push({
          path: fullPath,
          label: value._meta.label,
          test: value._meta.test || null,
        });
      }

      // Recurse into nested objects
      if (value._def?.typeName === 'ZodObject' || value._def?.typeName === 'ZodDefault') {
        const inner = value._def.innerType || value;
        results.push(...extractOptions(inner, fullPath));
      }
    }
  }

  return results;
}

function main() {
  const showOnlyMissing = process.argv.includes('--missing');

  const options = extractOptions(optionsSchema);

  const tested = options.filter(o => o.test);
  const untested = options.filter(o => !o.test);

  if (showOnlyMissing) {
    console.log('\n❌ Options without tests:\n');
    for (const opt of untested) {
      console.log(`  ${opt.path}`);
      console.log(`    └─ ${opt.label}`);
    }
  } else {
    console.log('\n✓ Options with tests:\n');
    for (const opt of tested) {
      console.log(`  ${opt.path}`);
      console.log(`    └─ ${opt.test}`);
    }

    console.log('\n❌ Options without tests:\n');
    for (const opt of untested) {
      console.log(`  ${opt.path}`);
      console.log(`    └─ ${opt.label}`);
    }
  }

  console.log('\n─────────────────────────────');
  console.log(`Coverage: ${tested.length}/${options.length} (${Math.round(100 * tested.length / options.length)}%)`);
  console.log('─────────────────────────────\n');

  // Exit with error if any untested (useful for CI)
  if (untested.length > 0 && process.argv.includes('--strict')) {
    process.exit(1);
  }
}

main();
