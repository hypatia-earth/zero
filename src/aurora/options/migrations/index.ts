/**
 * AuroraOptions schema migrations.
 *
 * Append-only: never edit older migrations. Each migration upgrades from one
 * `schemaVersion` to the next and returns the migrated blob.
 *
 * `CURRENT_SCHEMA_VERSION` is the version aurora writes today. On load, if
 * the stored blob is older, `migrate` runs each step in sequence until it
 * reaches the current version. If the stored blob is *newer* than this code
 * understands, `migrate` throws — never silently downgrade.
 */

import type { AuroraOptions } from '../../types/options';

export const CURRENT_SCHEMA_VERSION = 1;

export interface PersistedOptions {
  schemaVersion: number;
  options: AuroraOptions;
  lastModified: string; // ISO date
}

type MigrationStep = (blob: PersistedOptions) => PersistedOptions;

/**
 * Migrations from version N → N+1. Index 0 = 1→2, index 1 = 2→3, etc.
 * Empty today; populated in subsequent phases when AuroraOptions evolves.
 */
const MIGRATIONS: MigrationStep[] = [];

export function migrate(blob: PersistedOptions): PersistedOptions {
  if (blob.schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `aurora-db: stored schemaVersion ${blob.schemaVersion} is newer than supported ${CURRENT_SCHEMA_VERSION}`,
    );
  }
  let cur = blob;
  while (cur.schemaVersion < CURRENT_SCHEMA_VERSION) {
    const step = MIGRATIONS[cur.schemaVersion - 1];
    if (!step) {
      throw new Error(`aurora-db: missing migration step from v${cur.schemaVersion}`);
    }
    cur = step(cur);
  }
  return cur;
}
