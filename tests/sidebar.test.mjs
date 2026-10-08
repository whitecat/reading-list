import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

const en = JSON.parse(
  readFileSync(
    new URL('../extension/_locales/en/messages.json', import.meta.url),
  ),
);
const window = new Window({ url: 'https://reading-list.test/' });
for (const key of [
  'window',
  'document',
  'customElements',
  'HTMLElement',
  'Element',
  'Node',
  'Document',
  'ShadowRoot',
  'MutationObserver',
  'Event',
  'CustomEvent',
  'MouseEvent',
  'KeyboardEvent',
  'InputEvent',
  'CSSStyleSheet',
]) {
  globalThis[key] = window[key];
}
Object.defineProperty(globalThis, 'navigator', {
  value: window.navigator,
  configurable: true,
});
window.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
});
const local = {};
const area = (records) => ({
  async get() {
    return { ...records };
  },
  async set(entries) {
    Object.assign(records, entries);
  },
  async remove(key) {
    delete records[key];
  },
});
let storageListener;
let runtimeListener;
let getCurrentCalls = 0;
let openPanels = [];
const opened = [];
const sent = [];
globalThis.chrome = {
  runtime: {
    onMessage: {
      addListener: (listener) => (runtimeListener = listener),
      removeListener() {},
    },
    async sendMessage(message) {
      sent.push(message);
      return message.type === 'side-panel-open' && openPanels.length > 0
        ? true
        : undefined;
    },
    async openOptionsPage() {},
    getManifest() {
      return { version: '3.1.0' };
    },
  },
  i18n: {
    getMessage: (key) => en[key]?.message ?? '',
    getUILanguage: () => 'en',
  },
  storage: {
    local: area(local),
    sync: area({}),
    onChanged: {
      addListener: (listener) => (storageListener = listener),
      removeListener() {},
    },
  },
  tabs: {
    async query() {
      return [{ id: 1, url: 'https://example.com/new', title: 'A new page' }];
    },
    async update() {},
    async create() {},
  },
  windows: {
    async getCurrent() {
      getCurrentCalls++;
      return { id: 7 };
    },
  },
};
await import('../extension/scripts/components/reading-list-app.js');
const { rl } = await import('../extension/scripts/lib/rl.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const mount = async () => {
  document.body.innerHTML = '';
  const app = document.createElement('reading-list-app');
  document.body.append(app);
  await settle();
  await app.updateComplete;
  return app;
};
const button = (app) => app.shadowRoot.querySelector('.sidebar-toggle');

test('sidebar button is hidden when no sidebar API exists', async () => {
  document.body.className = 'popup-page';
  const app = await mount();
  assert.equal(button(app), null);
  assert.equal(app.hasAttribute('sidebar'), false);
});

test('Chrome side panel opens synchronously with the cached window id', async () => {
  chrome.sidePanel = {
    open: (options) => {
      opened.push(options);
      return Promise.resolve();
    },
  };
  document.body.className = 'popup-page';
  const app = await mount();
  const toggle = button(app);
  assert.ok(toggle);
  assert.equal(toggle.getAttribute('aria-label'), 'Open sidebar');
  assert.equal(toggle.getAttribute('title'), 'Sidebar');
  assert.equal(getCurrentCalls, 1);
  const before = opened.length;
  toggle.click();
  assert.deepEqual(opened.slice(before), [{ windowId: 7 }]);
  delete chrome.sidePanel;
});

test('Chrome side panel closes when it is already open', async () => {
  const closed = [];
  chrome.sidePanel = {
    open: (options) => {
      opened.push(options);
      return Promise.resolve();
    },
    close: (options) => {
      closed.push(options);
      return Promise.resolve();
    },
  };
  openPanels = [{ contextType: 'SIDE_PANEL' }];
  document.body.className = 'popup-page';
  const app = await mount();
  const before = opened.length;
  button(app).click();
  assert.deepEqual(closed, [{ windowId: 7 }]);
  assert.equal(opened.length, before);
  openPanels = [];
  delete chrome.sidePanel;
});

test('without sidePanel.close, the open panel is asked to close itself', async () => {
  chrome.sidePanel = { open: () => Promise.resolve() };
  openPanels = [{ contextType: 'SIDE_PANEL' }];
  document.body.className = 'popup-page';
  const popup = await mount();
  button(popup).click();
  assert.deepEqual(sent.at(-1), { type: 'close-side-panel', windowId: 7 });
  openPanels = [];

  document.body.className = 'sidebar-page';
  await mount();
  let closes = 0;
  const close = window.close;
  window.close = () => closes++;
  const answers = [];
  runtimeListener({ type: 'side-panel-open', windowId: 8 }, {}, (r) =>
    answers.push(r),
  );
  runtimeListener({ type: 'side-panel-open', windowId: 7 }, {}, (r) =>
    answers.push(r),
  );
  assert.deepEqual(answers, [true]);
  runtimeListener({ type: 'close-side-panel', windowId: 8 }, {}, () => {});
  assert.equal(closes, 0);
  runtimeListener({ type: 'close-side-panel', windowId: 7 }, {}, () => {});
  assert.equal(closes, 1);
  window.close = close;
  delete chrome.sidePanel;
});

test('Firefox sidebar toggles through browser.sidebarAction', async () => {
  let toggles = 0;
  window.browser = { sidebarAction: { toggle: () => toggles++ } };
  document.body.className = 'popup-page';
  const app = await mount();
  button(app).click();
  assert.equal(toggles, 1);
  delete window.browser;
});

test('sidebar button is hidden and the host marked inside the sidebar page', async () => {
  chrome.sidePanel = { open: () => Promise.resolve() };
  document.body.className = 'sidebar-page';
  const app = await mount();
  assert.equal(button(app), null);
  assert.equal(app.hasAttribute('sidebar'), true);
  delete chrome.sidePanel;
});

test('local item changes refresh an open sidebar', async () => {
  document.body.className = 'sidebar-page';
  await mount();
  let refreshes = 0;
  const original = rl.refresh;
  rl.refresh = async (...args) => {
    refreshes++;
    return original.apply(rl, args);
  };
  const changed = { oldValue: { title: 'Old' }, newValue: { title: 'New' } };
  storageListener({ 'rl:v1:item:https://example.com/a': changed }, 'local');
  storageListener(
    { 'rl:v1:deleted:https://example.com/a': { newValue: 1 } },
    'local',
  );
  storageListener({ 'rl:v1:settings': changed }, 'local');
  storageListener({ unrelated: changed }, 'local');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(refreshes, 1);
  storageListener({ 'rl:v1:item:https://example.com/a': changed }, 'local');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(refreshes, 2);
  storageListener({ unrelated: changed }, 'local');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(refreshes, 2);
  rl.refresh = original;
});

test('unchanged writes do not refresh, so Firefox cannot loop', async () => {
  document.body.className = 'sidebar-page';
  await mount();
  let refreshes = 0;
  const original = rl.refresh;
  rl.refresh = async (...args) => {
    refreshes++;
    return original.apply(rl, args);
  };
  const item = { url: 'https://example.com/a', title: 'Same', addedAt: 1 };
  const reordered = { addedAt: 1, title: 'Same', url: 'https://example.com/a' };
  storageListener(
    {
      'rl:v1:item:https://example.com/a': {
        oldValue: item,
        newValue: reordered,
      },
    },
    'local',
  );
  storageListener(
    {
      'rl:v1:settings': {
        oldValue: { theme: 'light' },
        newValue: { theme: 'light' },
      },
    },
    'local',
  );
  storageListener(
    { 'https://example.com/a': { oldValue: item, newValue: item } },
    'sync',
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(refreshes, 0);
  rl.refresh = original;
});
