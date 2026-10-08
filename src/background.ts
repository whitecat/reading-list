import { rl } from './lib/rl.js';
import { normalizeSettings } from './lib/settings.js';
import { i18n } from './lib/i18n.js';

const ADD_PAGE_MENU = 'add-page-to-reading-list';
const ADD_LINK_MENU = 'add-link-to-reading-list';
const LOCAL_SETTINGS_KEY = 'rl:v1:settings';
const ITEM_PREFIX = 'rl:v1:item:';
const DELETED_PREFIX = 'rl:v1:deleted:';
const SAVED_BADGE = '✔';

const isWebUrl = (url: string | undefined): url is string =>
  !!url && /^https?:\/\//i.test(url);

async function addContextMenuEnabled(): Promise<boolean> {
  const local = await chrome.storage.local.get(LOCAL_SETTINGS_KEY);
  if (local[LOCAL_SETTINGS_KEY]) {
    return normalizeSettings(local[LOCAL_SETTINGS_KEY]).addContextMenu;
  }
  const sync = await chrome.storage.sync.get('settings');
  return normalizeSettings(sync.settings, true).addContextMenu;
}

async function syncContextMenus() {
  const enabled = await addContextMenuEnabled();
  await chrome.contextMenus.removeAll();
  if (!enabled) return;
  chrome.contextMenus.create({
    id: ADD_PAGE_MENU,
    title: i18n.getMessage('addPage'),
    contexts: ['page'],
  });
  chrome.contextMenus.create({
    id: ADD_LINK_MENU,
    title: i18n.getMessage('addLink'),
    contexts: ['link'],
  });
}

async function syncBadge(tabId: number, url: string | undefined) {
  const saved = isWebUrl(url) && (await rl.isSaved(url));
  await chrome.action.setBadgeText({ tabId, text: saved ? SAVED_BADGE : '' });
}

async function syncBadgesForActiveTabs() {
  const tabs = await chrome.tabs.query({ active: true });
  await Promise.all(
    tabs.map((tab) => tab.id !== undefined && syncBadge(tab.id, tab.url)),
  );
}

async function markViewedOnArrival(url: string | undefined) {
  if (!isWebUrl(url) || !(await rl.isSaved(url))) return;
  const items = await rl.refresh();
  if (items.find((entry) => entry.url === url)?.viewed) return;
  await rl.markViewed(url);
}

function save(url: string | undefined, title: string | undefined) {
  if (!isWebUrl(url)) return;
  rl.saveCurrentPage({ url, title: title || url, addedAt: Date.now() }).catch(
    console.error,
  );
}

chrome.action.setBadgeBackgroundColor({ color: '#2ea99c' });

chrome.runtime.onInstalled.addListener(() => {
  syncContextMenus().catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  syncContextMenus().catch(console.error);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === ADD_PAGE_MENU) save(tab?.url, tab?.title);
  else if (info.menuItemId === ADD_LINK_MENU) {
    save(info.linkUrl, info.selectionText);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    (areaName === 'local' && LOCAL_SETTINGS_KEY in changes) ||
    (areaName === 'sync' && 'settings' in changes)
  ) {
    syncContextMenus().catch(console.error);
  }
  if (
    areaName === 'local' &&
    Object.keys(changes).some(
      (key) => key.startsWith(ITEM_PREFIX) || key.startsWith(DELETED_PREFIX),
    )
  ) {
    syncBadgesForActiveTabs().catch(console.error);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await syncBadge(tabId, tab.url);
    await markViewedOnArrival(tab.url);
  } catch (error) {
    console.error(error);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  try {
    await syncBadge(tabId, tab.url);
    if (changeInfo.url && tab.active) await markViewedOnArrival(tab.url);
  } catch (error) {
    console.error(error);
  }
});
