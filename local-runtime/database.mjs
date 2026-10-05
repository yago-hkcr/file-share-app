import { PGlite } from '@electric-sql/pglite';

export async function openLocalDatabase(dataDir) {
  return PGlite.create(dataDir);
}
