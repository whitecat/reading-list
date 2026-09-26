import { flatStore } from './flat-store.js';
import { bucketStore } from './bucket-store.js';
import { BackendId, backupIds, StorageConfig } from './config.js';
import { loadItems, readItemsWithoutWriting } from './load.js';
import { ItemStore, ListItemData, syncBytes, writeSync } from './store.js';

export interface Backend {
  readonly id: BackendId;
  load(): Promise<ListItemData[]>;
  readWithoutWriting(): Promise<ListItemData[]>;
  upsert(items: ListItemData[]): Promise<void>;
  remove(urls: string[]): Promise<void>;
  replaceAll(items: ListItemData[]): Promise<void>;
  clear(): Promise<void>;
  describeFailedUpsert?(items: ListItemData[]): Promise<string>;
}

let syncStore: ItemStore | null = null;

async function loadSync(): Promise<ListItemData[]> {
  const { items, store } = await loadItems();
  syncStore = store;
  return items;
}

async function readySyncStore(): Promise<ItemStore> {
  if (!syncStore) await loadSync();
  return syncStore!;
}

const syncItemKeys = async () =>
  Object.keys(await chrome.storage.sync.get(null)).filter(
    (key) => bucketStore.ownsKey(key) || flatStore.ownsKey(key),
  );

const syncBackend: Backend = {
  id: 'sync',
  load: loadSync,
  readWithoutWriting: readItemsWithoutWriting,
  async upsert(items) {
    await writeSync(await (await readySyncStore()).planUpsert(items));
  },
  async remove(urls) {
    await writeSync(await (await readySyncStore()).planRemove(urls));
  },
  async replaceAll(items) {
    const store = await readySyncStore();
    const { data } = store.layout(items);
    const stale = (await syncItemKeys()).filter((key) => !(key in data));
    await writeSync({ set: {}, remove: stale });
    await writeSync({ set: data, remove: [] });
    syncStore = null;
  },
  async clear() {
    await chrome.storage.sync.remove(await syncItemKeys());
    syncStore = null;
  },
  async describeFailedUpsert(items) {
    const { set } = await (await readySyncStore()).planUpsert(items);
    const keyBytes = Object.entries(set).map(([key, value]) =>
      syncBytes(key, value),
    );
    const inUse = await chrome.storage.sync
      .getBytesInUse(null)
      .catch(() => 'unknown');
    return (
      `sync bytes in use ${inUse}, this batch: ${keyBytes.length} keys / ` +
      `~${keyBytes.reduce((total, bytes) => total + bytes, 0)}B ` +
      `(largest key ~${Math.max(0, ...keyBytes)}B)`
    );
  },
};

export const LOCAL_ITEMS_KEY = 'readingListItems';

async function readLocalItems(): Promise<ListItemData[]> {
  const stored = await chrome.storage.local.get(LOCAL_ITEMS_KEY);
  return (stored[LOCAL_ITEMS_KEY] as ListItemData[] | undefined) ?? [];
}

const writeLocalItems = (items: ListItemData[]) =>
  chrome.storage.local.set({ [LOCAL_ITEMS_KEY]: items });

const localBackend: Backend = {
  id: 'local',
  load: readLocalItems,
  readWithoutWriting: readLocalItems,
  async upsert(items) {
    const byUrl = new Map(items.map((item) => [item.url, item]));
    const current = await readLocalItems();
    const currentUrls = new Set(current.map((item) => item.url));
    await writeLocalItems([
      ...items.filter((item) => !currentUrls.has(item.url)),
      ...current.map((item) => byUrl.get(item.url) ?? item),
    ]);
  },
  async remove(urls) {
    const removed = new Set(urls);
    await writeLocalItems(
      (await readLocalItems()).filter((item) => !removed.has(item.url)),
    );
  },
  replaceAll: writeLocalItems,
  clear: () => chrome.storage.local.remove(LOCAL_ITEMS_KEY),
};

const API_TIMEOUT_MS = 15000;

export const apiItemsUrl = (baseUrl: string, path = '') =>
  `${baseUrl.trim().replace(/\/+$/, '')}/items${path}`;

function apiBackend(config: StorageConfig): Backend {
  async function request(
    method: string,
    path = '',
    body?: unknown,
  ): Promise<Response> {
    if (!config.apiUrl.trim()) throw new Error('No API URL is configured');
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (config.apiToken) headers.Authorization = `Bearer ${config.apiToken}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const response = await fetch(apiItemsUrl(config.apiUrl, path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `API ${method} ${path || '/items'} failed: ${response.status} ${response.statusText}`,
        );
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async function readItems(): Promise<ListItemData[]> {
    const items: unknown = await (await request('GET')).json();
    if (!Array.isArray(items))
      throw new Error('API GET /items did not return an array');
    return items as ListItemData[];
  }

  return {
    id: 'api',
    load: readItems,
    readWithoutWriting: readItems,
    upsert: async (items) => void (await request('POST', '', items)),
    remove: async (urls) => void (await request('POST', '/delete', { urls })),
    replaceAll: async (items) => void (await request('PUT', '', items)),
    clear: async () => void (await request('PUT', '', [])),
  };
}

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
