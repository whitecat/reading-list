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
let getCurrentCalls = 0;
const opened = [];
globalThis.chrome = {
  runtime: {
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
  storageListener({ 'rl:v1:item:https://example.com/a': {} }, 'local');
  storageListener({ 'rl:v1:deleted:https://example.com/a': {} }, 'local');
  storageListener({ 'rl:v1:settings': {} }, 'local');
  storageListener({ unrelated: {} }, 'local');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(refreshes, 1);
  storageListener({ 'rl:v1:item:https://example.com/a': {} }, 'local');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(refreshes, 2);
  storageListener({ unrelated: {} }, 'local');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(refreshes, 2);
  rl.refresh = original;
});
