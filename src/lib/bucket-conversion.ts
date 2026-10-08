import LZString from 'lz-string';
import { isDeletionMarker, isStoredItem, StoredItem } from './storage-model.js';

const ITEM_PREFIX = 'rl:v1:item:';
const DELETED_PREFIX = 'rl:v1:deleted:';
const SHADOW_PREFIX = 'rl:v1:sync-shadow:';
const BACKUP_KEY = 'rl:v1:bucket-backup';
const BUCKET_KEY = /^b\d+$/;
const BUCKET_COUNT_KEY = '__bv';
const SYNC_BATCH_SIZE = 25;

function parseBucket(text: string | null): unknown[] | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function decodeBucket(raw: unknown): StoredItem[] {
  if (typeof raw !== 'string') return [];
  const entries =
    parseBucket(LZString.decompressFromBase64(raw)) ??
    parseBucket(LZString.decompressFromUTF16(raw)) ??
    [];
  const items: StoredItem[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { url, title, addedAt } = entry as Record<string, unknown>;
    if (typeof url !== 'string' || !url || isDeletionMarker(url, entry))
      continue;
    items.push({
      ...entry,
      url,
      title: typeof title === 'string' ? title : url,
      addedAt:
        typeof addedAt === 'number' && Number.isFinite(addedAt) ? addedAt : 0,
    });
  }
  return items;
}

function uniqueByUrl(items: StoredItem[]): StoredItem[] {
  const byUrl = new Map<string, StoredItem>();
  for (const item of items) {
    if (!byUrl.has(item.url)) byUrl.set(item.url, item);
  }
  return [...byUrl.values()];
}

async function saveSnapshot(decoded: StoredItem[]): Promise<void> {
  const stored = (await chrome.storage.local.get(BACKUP_KEY))[BACKUP_KEY];
  const earlier: StoredItem[] = Array.isArray(stored?.items)
    ? stored.items
    : [];
  const items = uniqueByUrl([...earlier, ...decoded]);
  await chrome.storage.local.set({
    [BACKUP_KEY]: { savedAt: Date.now(), items },
  });
  const saved = (await chrome.storage.local.get(BACKUP_KEY))[BACKUP_KEY];
  const savedUrls = new Set<string>(
    (saved?.items ?? []).map((item: StoredItem) => item.url),
  );
  if (!decoded.every((item) => savedUrls.has(item.url))) {
    throw new Error(
      'Reading List could not verify its backup of the old list.',
    );
  }
}

export async function convertBuckets(): Promise<void> {
  let sync: Record<string, unknown>;
  try {
    sync = await chrome.storage.sync.get(null);
  } catch {
    return;
  }
  const bucketKeys = Object.keys(sync).filter(
    (key) => key === BUCKET_COUNT_KEY || BUCKET_KEY.test(key),
  );
  if (bucketKeys.length === 0) return;

  const decoded = uniqueByUrl(
    bucketKeys
      .filter((key) => BUCKET_KEY.test(key))
      .flatMap((key) => decodeBucket(sync[key])),
  );
  await saveSnapshot(decoded);

  const urls = decoded.map((item) => item.url);
  const local = await chrome.storage.local.get(
    urls.flatMap((url) => [ITEM_PREFIX + url, DELETED_PREFIX + url]),
  );
  const kept: StoredItem[] = [];
  const writes: Record<string, StoredItem> = {};
  for (const item of decoded) {
    if (typeof local[DELETED_PREFIX + item.url] === 'number') continue;
    const existing = local[ITEM_PREFIX + item.url];
    if (isStoredItem(item.url, existing)) {
      kept.push(existing);
    } else {
      writes[ITEM_PREFIX + item.url] = item;
      kept.push(item);
    }
  }
  if (Object.keys(writes).length > 0) {
    await chrome.storage.local.set(writes);
    const written = await chrome.storage.local.get(Object.keys(writes));
    if (!Object.keys(writes).every((key) => written[key])) {
      throw new Error('Reading List could not verify the converted list.');
    }
  }

  try {
    await chrome.storage.sync.remove(bucketKeys);
  } catch {
    return;
  }

  const unsynced = kept.filter(
    (item) => !Object.prototype.hasOwnProperty.call(sync, item.url),
  );
  for (let start = 0; start < unsynced.length; start += SYNC_BATCH_SIZE) {
    const batch = unsynced.slice(start, start + SYNC_BATCH_SIZE);
    try {
      await chrome.storage.sync.set(
        Object.fromEntries(batch.map((item) => [item.url, item])),
      );
    } catch {
      return;
    }
    await chrome.storage.local.set(
      Object.fromEntries(batch.map((item) => [SHADOW_PREFIX + item.url, item])),
    );
  }
}
