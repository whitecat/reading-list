export type BackendId = 'sync' | 'local' | 'api';

export const BACKEND_IDS: BackendId[] = ['sync', 'local', 'api'];

export interface StorageConfig {
  primary: BackendId;
  enabled: Record<BackendId, boolean>;
  apiUrl: string;
  apiToken: string;
}

export const DEFAULT_STORAGE_CONFIG: StorageConfig = {
  primary: 'sync',
  enabled: { sync: true, local: false, api: false },
  apiUrl: '',
  apiToken: '',
};

const CONFIG_KEY = 'storageConfig';

export async function getStorageConfig(): Promise<StorageConfig> {
  const stored = (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY] as
    Partial<StorageConfig> | undefined;
  const config: StorageConfig = {
    ...DEFAULT_STORAGE_CONFIG,
    ...stored,
    enabled: { ...DEFAULT_STORAGE_CONFIG.enabled, ...stored?.enabled },
  };
  config.enabled[config.primary] = true;
  return config;
}

export async function saveStorageConfig(config: StorageConfig): Promise<void> {
  await chrome.storage.local.set({
    [CONFIG_KEY]: {
      ...config,
      enabled: { ...config.enabled, [config.primary]: true },
    },
  });
}

export const backupIds = (config: StorageConfig): BackendId[] =>
  BACKEND_IDS.filter((id) => id !== config.primary && config.enabled[id]);
