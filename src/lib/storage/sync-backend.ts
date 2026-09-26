import type { Backend } from './backend.js';
import { bucketStore } from './bucket-store.js';
import { flatStore } from './flat-store.js';
import { loadItems, readItemsWithoutWriting } from './load.js';
import { ItemStore, ListItemData, syncBytes, writeSync } from './store.js';

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

export const syncBackend: Backend = {
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
