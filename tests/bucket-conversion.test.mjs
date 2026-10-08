import assert from 'node:assert/strict';
import test from 'node:test';
import LZString from 'lz-string';
import { RL } from '../extension/scripts/lib/rl.js';

const TOTAL_QUOTA = 102400;
const ITEM_QUOTA = 8192;
const MAX_KEYS = 512;
const bytes = (text) => Buffer.byteLength(text, 'utf8');

function quotaError() {
  return new Error(
    'QuotaExceededError: storage.sync API call exceeded its quota limitations.',
  );
}

function syncArea(initial = {}) {
  const values = { ...initial };
  const area = {
    values,
    setCalls: 0,
    failSet: false,
    async get() {
      return JSON.parse(JSON.stringify(values));
    },
    async set(entries) {
      area.setCalls++;
      if (area.failSet) throw quotaError();
      const after = { ...values, ...entries };
      if (Object.keys(after).length > MAX_KEYS) throw quotaError();
      for (const [key, value] of Object.entries(after)) {
        if (bytes(key + JSON.stringify(value)) > ITEM_QUOTA) throw quotaError();
      }
      if (bytes(JSON.stringify(after)) > TOTAL_QUOTA) throw quotaError();
      Object.assign(values, JSON.parse(JSON.stringify(entries)));
    },
    async remove(keys) {
      for (const key of [].concat(keys)) delete values[key];
    },
  };
  return area;
}

function localArea(initial = {}) {
  const values = { ...initial };
  const area = {
    values,
    failSet: false,
    async get(keys) {
      if (keys === null || keys === undefined) return { ...values };
      const picked = {};
      for (const key of [].concat(keys))
        if (key in values) picked[key] = values[key];
      return picked;
    },
    async set(entries) {
      if (area.failSet) throw new Error('local write failed');
      Object.assign(values, entries);
    },
    async remove(keys) {
      for (const key of [].concat(keys)) delete values[key];
    },
  };
  return area;
}

function bucketIndex(url, count) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % count;
}

function layOutBuckets(items, count = 25, encode = LZString.compressToBase64) {
  const groups = Array.from({ length: count }, () => []);
  for (const item of items) groups[bucketIndex(item.url, count)].push(item);
  const data = { __bv: count };
  groups.forEach((group, index) => {
    if (group.length) data[`b${index}`] = encode(JSON.stringify(group));
  });
  return data;
}

function makeItems(count, padding = 0) {
  return Array.from({ length: count }, (_, i) => ({
    url: `https://example${i % 7}.com/articles/${i}/some-long-article-slug?utm_source=feed&id=${i * 7919}${'x'.repeat(padding)}`,
    title: `Article number ${i}: a realistic and fairly descriptive page title ${i * 31}`,
    addedAt: 1700000000000 + i * 1000,
    ...(i % 3 === 0
      ? { favIconUrl: `https://example${i % 7}.com/favicon.ico`, viewed: true }
      : {}),
    ...(i % 5 === 0 ? { index: i - 20 } : {}),
  }));
}

function install(syncInitial, localInitial) {
  const sync = syncArea(syncInitial);
  const local = localArea(localInitial);
  globalThis.chrome = { storage: { sync, local } };
  return { sync, local };
}

const byUrl = (items) => [...items].sort((a, b) => a.url.localeCompare(b.url));
const isBucketKey = (key) => key === '__bv' || /^b\d+$/.test(key);

test('3.7 buckets convert to a local list and flat sync records', async () => {
  const items = makeItems(40);
  const settings = { sortOrder: 'oldest', animate: false };
  const { sync, local } = install({ ...layOutBuckets(items), settings });

  const loaded = await new RL().getListItems();
  assert.deepEqual(byUrl(loaded), byUrl(items));
  assert.equal(Object.keys(sync.values).filter(isBucketKey).length, 0);
  for (const item of items) assert.deepEqual(sync.values[item.url], item);
  assert.deepEqual(sync.values.settings, settings);
  assert.ok(local.values['rl:v1:bucket-backup'].items.length === items.length);

  const setCalls = sync.setCalls;
  const again = new RL();
  assert.deepEqual(byUrl(await again.getListItems()), byUrl(items));
  assert.equal(sync.setCalls, setCalls);
  assert.equal(again.localOnlyCount, 0);
});

test('a list near the quota keeps every item and reports the unsynced ones', async () => {
  const items = makeItems(325, 90);
  const buckets = layOutBuckets(items);
  const { sync } = install(buckets);
  assert.ok(bytes(JSON.stringify(buckets)) <= TOTAL_QUOTA);

  const list = new RL();
  const loaded = await list.getListItems();
  assert.deepEqual(byUrl(loaded), byUrl(items));
  const flatCount = Object.keys(sync.values).filter((key) =>
    key.startsWith('http'),
  ).length;
  assert.equal(list.localOnlyCount, items.length - flatCount);
  assert.ok(list.localOnlyCount > 0);
  assert.ok(sync.setCalls <= Math.ceil(items.length / 25));
  assert.deepEqual(byUrl(await new RL().getListItems()), byUrl(items));
});

test('an old UTF16-encoded bucket decodes', async () => {
  const items = makeItems(6);
  install(layOutBuckets(items, 25, LZString.compressToUTF16));
  assert.deepEqual(byUrl(await new RL().getListItems()), byUrl(items));
});

test('a corrupt bucket is skipped and the others still convert', async () => {
  const items = makeItems(12);
  const buckets = layOutBuckets(items);
  const keys = Object.keys(buckets).filter((key) => key !== '__bv');
  const corrupted = keys[0];
  const lost = new Set(
    items
      .filter((item) => `b${bucketIndex(item.url, 25)}` === corrupted)
      .map((item) => item.url),
  );
  buckets[corrupted] = 'not a real bucket';
  buckets[keys[1]] = 42;
  const survivors = items.filter(
    (item) =>
      !lost.has(item.url) && `b${bucketIndex(item.url, 25)}` !== keys[1],
  );
  const { sync } = install(buckets);

  assert.deepEqual(byUrl(await new RL().getListItems()), byUrl(survivors));
  assert.equal(Object.keys(sync.values).filter(isBucketKey).length, 0);
});

test('entries are normalized and duplicates keep the first copy', async () => {
  const raw = [
    { url: 'https://a.example/', title: 5, addedAt: 'soon' },
    { url: 'https://a.example/', title: 'Second copy', addedAt: 9 },
    { title: 'no url', addedAt: 1 },
    'junk',
  ];
  install({ __bv: 25, b0: LZString.compressToBase64(JSON.stringify(raw)) });
  assert.deepEqual(await new RL().getListItems(), [
    { url: 'https://a.example/', title: 'https://a.example/', addedAt: 0 },
  ]);
});

test('a failed local snapshot rejects the load and leaves sync untouched', async () => {
  const buckets = {
    ...layOutBuckets(makeItems(10)),
    settings: { sortOrder: 'newest' },
  };
  const { sync, local } = install(buckets);
  const before = JSON.stringify(sync.values);
  local.failSet = true;

  await assert.rejects(new RL().getListItems());
  assert.equal(JSON.stringify(sync.values), before);
  assert.equal(sync.setCalls, 0);
});

test('a conversion whose sync copy fails loses nothing on the next load', async () => {
  const items = makeItems(30);
  const { sync } = install(layOutBuckets(items));
  sync.failSet = true;

  const first = new RL();
  assert.deepEqual(byUrl(await first.getListItems()), byUrl(items));
  assert.equal(first.localOnlyCount, items.length);
  assert.equal(Object.keys(sync.values).filter(isBucketKey).length, 0);

  sync.failSet = false;
  const second = new RL();
  assert.deepEqual(byUrl(await second.getListItems()), byUrl(items));
  const result = await second.retrySync();
  assert.equal(result.remaining, items.length - 25);
  assert.deepEqual(byUrl(await new RL().getListItems()), byUrl(items));
});

test('the local copy wins and a local deletion is not resurrected', async () => {
  const items = makeItems(5);
  const [kept, deleted, plain] = items;
  const edited = { ...kept, title: 'Renamed on this device' };
  const { sync, local } = install(layOutBuckets(items), {
    [`rl:v1:item:${kept.url}`]: edited,
    [`rl:v1:deleted:${deleted.url}`]: 1700000005000,
  });

  const loaded = await new RL().getListItems();
  assert.equal(
    loaded.find((item) => item.url === kept.url).title,
    'Renamed on this device',
  );
  assert.ok(!loaded.some((item) => item.url === deleted.url));
  assert.ok(loaded.some((item) => item.url === plain.url));
  assert.equal(loaded.length, 4);
  assert.deepEqual(sync.values[kept.url], edited);
  assert.ok(!(deleted.url in sync.values));
  assert.equal(local.values[`rl:v1:deleted:${deleted.url}`], 1700000005000);
});

test('an existing flat sync record is not overwritten by the conversion', async () => {
  const [item] = makeItems(1);
  const other = { ...item, title: 'From another device' };
  const { sync } = install({ ...layOutBuckets([item]), [item.url]: other });

  await new RL().getListItems();
  assert.deepEqual(sync.values[item.url], other);
});

test('flat per-URL sync data without buckets makes no extra writes', async () => {
  const [item] = makeItems(1);
  const { sync } = install({ [item.url]: item });
  assert.deepEqual(await new RL().getListItems(), [item]);
  assert.equal(sync.setCalls, 0);
});

test('a failed bucket removal still shows the converted list', async () => {
  const items = makeItems(30);
  const { sync } = install(layOutBuckets(items));
  sync.remove = async () => {
    throw new Error('rate limited');
  };

  assert.deepEqual(byUrl(await new RL().getListItems()), byUrl(items));
  assert.deepEqual(byUrl(await new RL().getListItems()), byUrl(items));
});

test('a deletion marker folded into a bucket by 3.7 is not turned into a page', async () => {
  const items = makeItems(5);
  const marker = {
    url: 'https://deleted.example/page',
    deletedAt: 1700000009000,
  };
  install(layOutBuckets([...items, marker]));

  const list = await new RL().getListItems();
  assert.deepEqual(byUrl(list), byUrl(items));
});
