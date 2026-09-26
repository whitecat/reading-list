import { apiBackend } from './api-backend.js';
import type { Backend } from './backend.js';
import { BackendId, backupIds, StorageConfig } from './config.js';
import { localBackend } from './local-backend.js';
import { syncBackend } from './sync-backend.js';

export function backendFor(id: BackendId, config: StorageConfig): Backend {
  if (id === 'sync') return syncBackend;
  if (id === 'local') return localBackend;
  return apiBackend(config);
}

export interface StorageTargets {
  primary: Backend;
  backups: Backend[];
}

export const storageTargets = (config: StorageConfig): StorageTargets => ({
  primary: backendFor(config.primary, config),
  backups: backupIds(config).map((id) => backendFor(id, config)),
});
