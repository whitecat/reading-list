import type { Backend } from './backend.js';
import { ListItemData } from './store.js';

export const LOCAL_ITEMS_KEY = 'readingListItems';

async function readLocalItems(): Promise<ListItemData[]> {
  const stored = await chrome.storage.local.get(LOCAL_ITEMS_KEY);
  return (stored[LOCAL_ITEMS_KEY] as ListItemData[] | undefined) ?? [];
}

const writeLocalItems = (items: ListItemData[]) =>
  chrome.storage.local.set({ [LOCAL_ITEMS_KEY]: items });

export const localBackend: Backend = {
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
