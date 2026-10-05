import {
  ItemStore,
  ListItemData,
  StorageFullError,
  StoreLayout,
  SyncData,
  syncBytes,
  syncQuotaBytesPerKey,
} from './store.js';

export const isFlatKey = (key: string): boolean => /^https?:\/\//i.test(key);

function layout(items: ListItemData[]): StoreLayout {
  const data: SyncData = {};
  for (const item of items) {
    if (syncBytes(item.url, item) > syncQuotaBytesPerKey()) {
      throw new StorageFullError(
        `An item is larger than ${syncQuotaBytesPerKey()} bytes`,
      );
    }
    data[item.url] = item;
  }
  return { data };
}

export const flatStore: ItemStore = {
  name: 'flat',
  ownsKey: isFlatKey,
  readItems: (data) =>
    Object.keys(data)
      .filter(isFlatKey)
      .map((key) => data[key] as ListItemData),
  layout,
  planUpsert: async (items) => ({ set: layout(items).data, remove: [] }),
  planUpdate: async (items) => {
    const existing = await chrome.storage.sync.get(
      items.map((item) => item.url),
    );
    return {
      set: layout(items.filter((item) => item.url in existing)).data,
      remove: [],
    };
  },
  planRemove: async (urls) => ({ set: {}, remove: urls }),
  afterLoad: () => {},
};
