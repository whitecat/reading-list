import assert from 'node:assert/strict';
import test from 'node:test';

const local = {};
const sync = {};
const listeners = {};
const menus = { created: [], removeAllCalls: 0 };
const badges = new Map();
const badgeColors = [];
let activeTabs = [];
const tabsById = new Map();

const area = (records) => ({
  async get(keys) {
    if (keys === null || keys === undefined) return { ...records };
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(
      list.filter((key) => key in records).map((key) => [key, records[key]]),
    );
  },
  async set(entries) {
    Object.assign(records, entries);
  },
  async remove(key) {
    delete records[key];
  },
});

const event = (name) => ({
  addListener(callback) {
    listeners[name] = callback;
  },
});

globalThis.chrome = {
  i18n: { getMessage: (key) => key },
  runtime: { onInstalled: event('installed'), onStartup: event('startup') },
  contextMenus: {
    onClicked: event('menuClicked'),
    async removeAll() {
      menus.removeAllCalls++;
      menus.created.length = 0;
    },
    create(properties) {
      menus.created.push(properties);
    },
  },
  action: {
    setBadgeBackgroundColor(details) {
      badgeColors.push(details.color);
    },
    async setBadgeText({ tabId, text }) {
      badges.set(tabId, text);
    },
  },
  tabs: {
    onActivated: event('activated'),
    onUpdated: event('updated'),
    async get(tabId) {
      return tabsById.get(tabId);
    },
    async query() {
      return activeTabs;
    },
  },
  storage: {
    local: area(local),
    sync: area(sync),
    onChanged: event('storageChanged'),
  },
};

await import('../extension/scripts/background.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const itemKey = (url) => `rl:v1:item:${url}`;
const reset = () => {
  for (const records of [local, sync]) {
    for (const key of Object.keys(records)) delete records[key];
  }
  menus.created.length = 0;
  menus.removeAllCalls = 0;
  badges.clear();
  activeTabs = [];
  tabsById.clear();
};
const seed = (url, extra = {}) => {
  const item = { url, title: 'Saved', addedAt: 100, ...extra };
  local[itemKey(url)] = item;
  sync[url] = item;
  return item;
};

test('the badge color is set when the worker starts', () => {
  assert.deepEqual(badgeColors, ['#2ea99c']);
});

test('menus are created on install and startup when the setting is on or absent', async () => {
  reset();
  await listeners.installed();
  await settle();
  assert.deepEqual(
    menus.created.map((menu) => [menu.title, menu.contexts]),
    [
      ['addPage', ['page']],
      ['addLink', ['link']],
    ],
  );
  local['rl:v1:settings'] = { addContextMenu: true };
  await listeners.startup();
  await settle();
  assert.equal(menus.created.length, 2);
});

test('menus are not created when the setting is off', async () => {
  reset();
  local['rl:v1:settings'] = { addContextMenu: false };
  await listeners.installed();
  await settle();
  assert.equal(menus.removeAllCalls, 1);
  assert.equal(menus.created.length, 0);
});

test('menus follow a legacy synced setting and settings changes', async () => {
  reset();
  sync.settings = { addContextMenu: false };
  await listeners.installed();
  await settle();
  assert.equal(menus.created.length, 0);
  sync.settings = { addContextMenu: true };
  listeners.storageChanged({ settings: {} }, 'sync');
  await settle();
  assert.equal(menus.created.length, 2);
  local['rl:v1:settings'] = { addContextMenu: false };
  listeners.storageChanged({ 'rl:v1:settings': {} }, 'local');
  await settle();
  assert.equal(menus.created.length, 0);
});

test('the page menu saves the tab and the link menu saves the link', async () => {
  reset();
  listeners.menuClicked(
    { menuItemId: 'add-page-to-reading-list' },
    { url: 'https://example.com/page', title: 'Page title' },
  );
  await settle();
  assert.equal(local[itemKey('https://example.com/page')].title, 'Page title');

  listeners.menuClicked(
    {
      menuItemId: 'add-link-to-reading-list',
      linkUrl: 'https://example.com/link',
      selectionText: 'Chosen text',
    },
    { url: 'https://example.com/page' },
  );
  listeners.menuClicked(
    {
      menuItemId: 'add-link-to-reading-list',
      linkUrl: 'https://example.com/bare',
    },
    {},
  );
  await settle();
  assert.equal(local[itemKey('https://example.com/link')].title, 'Chosen text');
  assert.equal(
    local[itemKey('https://example.com/bare')].title,
    'https://example.com/bare',
  );
});

test('non-http links and pages are ignored', async () => {
  reset();
  listeners.menuClicked(
    { menuItemId: 'add-link-to-reading-list', linkUrl: 'javascript:alert(1)' },
    {},
  );
  listeners.menuClicked(
    { menuItemId: 'add-page-to-reading-list' },
    { url: 'chrome://extensions', title: 'Extensions' },
  );
  await settle();
  assert.deepEqual(Object.keys(local), []);
});

test('the badge shows a check for saved tabs and clears after a delete', async () => {
  reset();
  const url = 'https://example.com/saved';
  seed(url, { viewed: true });
  tabsById.set(1, { id: 1, url });
  tabsById.set(2, { id: 2, url: 'https://example.com/other' });
  await listeners.activated({ tabId: 1 });
  await listeners.activated({ tabId: 2 });
  assert.equal(badges.get(1), '✔');
  assert.equal(badges.get(2), '');

  activeTabs = [{ id: 1, url }];
  local[`rl:v1:deleted:${url}`] = Date.now();
  listeners.storageChanged({ [`rl:v1:deleted:${url}`]: {} }, 'local');
  await settle();
  assert.equal(badges.get(1), '');
});

test('activating a saved unviewed tab marks it viewed', async () => {
  reset();
  const url = 'https://example.com/unread';
  seed(url);
  tabsById.set(3, { id: 3, url });
  await listeners.activated({ tabId: 3 });
  assert.equal(local[itemKey(url)].viewed, true);
});

test('load completion does not mark viewed but a navigation of the active tab does', async () => {
  reset();
  const url = 'https://example.com/loading';
  seed(url);
  await listeners.updated(
    4,
    { status: 'complete' },
    { id: 4, url, active: true },
  );
  assert.equal(badges.get(4), '✔');
  assert.equal(local[itemKey(url)].viewed, undefined);

  await listeners.updated(4, { url }, { id: 4, url, active: false });
  assert.equal(local[itemKey(url)].viewed, undefined);

  await listeners.updated(4, { url }, { id: 4, url, active: true });
  assert.equal(local[itemKey(url)].viewed, true);
});

test('a title edited in storage survives viewed marking', async () => {
  reset();
  const url = 'https://example.com/edited';
  seed(url);
  tabsById.set(5, { id: 5, url });
  await listeners.activated({ tabId: 5 });
  local[itemKey(url)] = {
    ...local[itemKey(url)],
    title: 'Edited',
    viewed: false,
  };
  await listeners.activated({ tabId: 5 });
  assert.equal(local[itemKey(url)].title, 'Edited');
  assert.equal(local[itemKey(url)].viewed, true);
});
