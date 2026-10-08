import { rl } from './lib/rl.js';
import { getSettings } from './lib/settings.js';
import { addPage, message, syncBadgeForTab } from './lib/browser.js';
import { isSavableUrl } from './lib/storage/store.js';

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

async function setPageActionVisible(
  tabId: number,
  url: string | undefined,
  enabled: boolean,
) {
  try {
    await (enabled && isSavableUrl(url)
      ? chrome.pageAction.show(tabId)
      : chrome.pageAction.hide(tabId));
  } catch (e) {
    console.error(e);
  }
}

const loadPageActionEnabled = async () => (await getSettings()).addPageAction;

let pageActionEnabled = loadPageActionEnabled();

async function syncPageActions() {
  if (!chrome.pageAction) return;
  pageActionEnabled = loadPageActionEnabled();
  const addPageAction = await pageActionEnabled;
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id !== undefined)
      await setPageActionVisible(tab.id, tab.url, addPageAction);
  }
}

function syncSettingsDrivenUi() {
  void syncContextMenu();
  void syncPageActions();
}

syncPageActions().catch(console.error);

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
    if (onList) {
      await rl.removeReadingItem(tab.url);
      await syncBadgeForTab(tab.id, tab.url);
    } else {
      await addPage(tab.url, tab.title || tab.url, tab.favIconUrl);
    }
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
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url) return;
    await syncBadgeForTab(tabId, tab.url).catch(console.error);
    await markViewed(tab.url);
  } catch (e) {
    console.error(e);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const navigated = !!changeInfo.url;
  const completed = changeInfo.status === 'complete';
  if (!navigated && !completed) return;
  try {
    if (chrome.pageAction) {
      await setPageActionVisible(tabId, tab.url, await pageActionEnabled);
    }
    if (!tab.url) return;
    await syncBadgeForTab(tabId, tab.url).catch(console.error);
    if (navigated && tab.active) await markViewed(tab.url);
  } catch (e) {
    console.error(e);
  }
});
