import type { MigrationDefinition } from './migrations';

export const defaultMigrations: MigrationDefinition[] = [
  {
    name: '20260924_120000_add_status_index',
    version: '20260924_120000',
    up: ['CREATE INDEX IF NOT EXISTS idx_users_role ON "User" (role);'],
    down: ['DROP INDEX IF EXISTS idx_users_role;'],
    transaction: true,
    description: 'Add a user-role lookup index for filtered queries.',
  },
];
