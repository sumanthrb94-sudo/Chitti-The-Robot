/**
 * Tiny wrapper around `ensureSeeded` so API routes don't have to import the
 * entire DB module surface just to bootstrap the database.
 */

import { ensureSeeded } from '@/lib/db';

export async function seedIfNeeded(): Promise<void> {
  ensureSeeded();
}
