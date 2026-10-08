import { rl } from './lib/rl.js';
import { getSettings } from './lib/settings.js';
import { addPage, message, syncBadgeForTab } from './lib/browser.js';

const ADD_PAGE_MENU = 'add-page-to-reading-list';
const ADD_LINK_MENU = 'add-link-to-reading-list';

chrome.action.setBadgeBackgroundColor({ color: '#2ea99c' });

async function syncContextMenu() {
  const settings = await getSettings();
  await chrome.contextMenus.removeAll();
  if (!settings.addContextMenu) return;
  chrome.contextMenus.create({
    id: ADD_PAGE_MENU,
    title: message('addPage'),
    contexts: ['page'],
  });
  chrome.contextMenus.create({
    id: ADD_LINK_MENU,
    title: message('addLink'),
    contexts: ['link'],
  });
}

function isSavableUrl(url?: string): url is string {
  return !!url && /^https?:\/\//i.test(url);
}

function setPageActionVisible(
  tabId: number,
  url: string | undefined,
  enabled: boolean,
) {
  if (enabled && isSavableUrl(url)) chrome.pageAction.show(tabId);
  else chrome.pageAction.hide(tabId);
}

async function syncPageActions() {
  if (!chrome.pageAction) return;
  const { addPageAction } = await getSettings();
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id !== undefined)
      setPageActionVisible(tab.id, tab.url, addPageAction);
  }
}

function syncSettingsDrivenUi() {
  void syncContextMenu();
  void syncPageActions();
}

chrome.runtime.onInstalled.addListener(syncSettingsDrivenUi);
chrome.runtime.onStartup.addListener(syncSettingsDrivenUi);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && 'settings' in changes) syncSettingsDrivenUi();
});

chrome.pageAction?.onClicked.addListener(async (tab) => {
  if (tab.id === undefined || !isSavableUrl(tab.url)) return;
  try {
    const onList = (await rl.getListItems()).some(
      (item) => item.url === tab.url,
    );
    if (onList) await rl.removeReadingItem(tab.url);
    else await addPage(tab.url, tab.title || tab.url, tab.favIconUrl);
    await syncBadgeForTab(tab.id, tab.url);
  } catch (e) {
    console.error(e);
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const added =
    info.menuItemId === ADD_LINK_MENU && info.linkUrl
      ? addPage(info.linkUrl, info.selectionText || info.linkUrl)
      : info.menuItemId === ADD_PAGE_MENU && tab?.url
        ? addPage(tab.url, tab.title || tab.url, tab.favIconUrl)
        : null;
  added?.catch(console.error);
});

async function markViewed(url: string) {
  await rl.updateReadingItem(url, { viewed: true });
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url) return;
  await syncBadgeForTab(tabId, tab.url);
  await markViewed(tab.url);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (chrome.pageAction) {
    const { addPageAction } = await getSettings();
    setPageActionVisible(tabId, tab.url, addPageAction);
  }
  if (!tab.url) return;
  if (changeInfo.status === 'complete') await syncBadgeForTab(tabId, tab.url);
  if (changeInfo.url) await markViewed(tab.url);
});
