import LZString from 'lz-string';
import {
  ItemStore,
  ListItemData,
  StorageFullError,
  StoreLayout,
  SyncData,
  serializedBytes,
  syncBytes,
  syncQuotaBytes,
  syncQuotaBytesPerKey,
  SyncWrite,
} from './store.js';

const BUCKET_KEY = /^b\d+$/;
const BUCKET_COUNT_KEY = '__bv';
const BUCKET_COUNTS = [25, 30, 35, 40];

let bucketCount = BUCKET_COUNTS[0];

export function bucketKey(url: string, count: number): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `b${(hash >>> 0) % count}`;
}

export const isBucketKey = (key: string): boolean => BUCKET_KEY.test(key);

export const isOldEncoding = (raw: unknown): boolean =>
  typeof raw === 'string' && /[^\x00-\x7f]/.test(raw);

const decompressCurrentOrPre30Encoding = (raw: string) =>
  LZString.decompressFromBase64(raw) || LZString.decompressFromUTF16(raw);

export function decodeBucket(raw: unknown): ListItemData[] {
  if (typeof raw !== 'string') return [];
  const json = decompressCurrentOrPre30Encoding(raw);
  if (!json) return [];
  try {
    return JSON.parse(json) as ListItemData[];
  } catch {
    return [];
  }
}

function encodeBucket(items: ListItemData[]): string {
  // Base64, not UTF16: see AGENTS.md "Why compressToBase64".
  return LZString.compressToBase64(JSON.stringify(items));
}

function groupByBucket<T>(
  entries: T[],
  urlOf: (entry: T) => string,
  count: number,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const entry of entries) {
    const key = bucketKey(urlOf(entry), count);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return groups;
}

function layoutAtCount(items: ListItemData[], count: number): SyncData | null {
  const data: SyncData = { [BUCKET_COUNT_KEY]: count };
  for (const [key, bucketItems] of groupByBucket(
    items,
    (item) => item.url,
    count,
  )) {
    data[key] = encodeBucket(bucketItems);
    if (syncBytes(key, data[key]) > syncQuotaBytesPerKey()) return null;
  }
  return serializedBytes(data) > syncQuotaBytes() ? null : data;
}

function layout(items: ListItemData[]): StoreLayout {
  let best: StoreLayout | null = null;
  for (const count of BUCKET_COUNTS) {
    const data = layoutAtCount(items, count);
    if (data && (!best || serializedBytes(data) < serializedBytes(best.data))) {
      best = { data, bucketCount: count };
    }
  }
  if (best) return best;
  throw new StorageFullError(
    `No bucket count fits ${syncQuotaBytes()} bytes with every bucket under ${syncQuotaBytesPerKey()} bytes`,
  );
}

function readItems(data: SyncData): ListItemData[] {
  return Object.keys(data)
    .filter(isBucketKey)
    .flatMap((key) => decodeBucket(data[key]));
}

async function afterLoad(data: SyncData, items: ListItemData[]): Promise<void> {
  const storedCount = data[BUCKET_COUNT_KEY];
  if (
    typeof storedCount === 'number' &&
    BUCKET_COUNTS.includes(storedCount) &&
    layoutAtCount(items, storedCount)
  ) {
    bucketCount = storedCount;
    return;
  }
  let fresh: StoreLayout;
  try {
    fresh = layout(items);
    await chrome.storage.sync.set(fresh.data);
  } catch (err) {
    if (typeof storedCount !== 'number') throw err;
    bucketCount = storedCount;
    return;
  }
  bucketCount = fresh.bucketCount!;
  const stale = Object.keys(data).filter(
    (key) => isBucketKey(key) && !(key in fresh.data),
  );
  if (stale.length > 0) await chrome.storage.sync.remove(stale);
}

async function planUpsert(items: ListItemData[]): Promise<SyncWrite> {
  const groups = groupByBucket(items, (item) => item.url, bucketCount);
  const current = await chrome.storage.sync.get([
    ...groups.keys(),
    BUCKET_COUNT_KEY,
  ]);
  const set: SyncData =
    BUCKET_COUNT_KEY in current ? {} : { [BUCKET_COUNT_KEY]: bucketCount };
  for (const [key, incoming] of groups) {
    const incomingByUrl = new Map(incoming.map((item) => [item.url, item]));
    const existing = decodeBucket(current[key]);
    const updated = existing.map((item) => incomingByUrl.get(item.url) ?? item);
    const existingUrls = new Set(existing.map((item) => item.url));
    const added = [...incomingByUrl.values()].filter(
      (item) => !existingUrls.has(item.url),
    );
    set[key] = encodeBucket([...added, ...updated]);
  }
  return { set, remove: [] };
}

async function planRemove(urls: string[]): Promise<SyncWrite> {
  const groups = groupByBucket(urls, (url) => url, bucketCount);
  const current = await chrome.storage.sync.get([...groups.keys()]);
  const write: SyncWrite = { set: {}, remove: [] };
  for (const [key, removedUrls] of groups) {
    const remaining = decodeBucket(current[key]).filter(
      (item) => !removedUrls.includes(item.url),
    );
    if (remaining.length > 0) write.set[key] = encodeBucket(remaining);
    else write.remove.push(key);
  }
  return write;
}

export const bucketStore: ItemStore = {
  name: 'buckets',
  ownsKey: (key) => isBucketKey(key) || key === BUCKET_COUNT_KEY,
  readItems,
  layout,
  planUpsert,
  planRemove,
  afterLoad,
};

export interface BucketStats {
  keys: string[];
  items: ListItemData[];
  itemsPerBucket: number[];
  unreadable: string[];
  oldEncoding: string[];
  storedCount: unknown;
  misplaced: number;
}

export function bucketStats(data: SyncData): BucketStats {
  const storedCount = data[BUCKET_COUNT_KEY];
  const stats: BucketStats = {
    keys: Object.keys(data).filter(isBucketKey),
    items: [],
    itemsPerBucket: [],
    unreadable: [],
    oldEncoding: [],
    storedCount,
    misplaced: 0,
  };
  for (const key of stats.keys) {
    const items = decodeBucket(data[key]);
    stats.items.push(...items);
    stats.itemsPerBucket.push(items.length);
    if (items.length === 0) stats.unreadable.push(key);
    if (isOldEncoding(data[key])) stats.oldEncoding.push(key);
    if (typeof storedCount === 'number') {
      stats.misplaced += items.filter(
        (item) =>
          typeof item?.url === 'string' &&
          bucketKey(item.url, storedCount) !== key,
      ).length;
    }
  }
  return stats;
}
