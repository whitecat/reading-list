# Reading List

A Chrome and Firefox extension for saving pages to read later. Free on the [Chrome Web Store](https://chrome.google.com/webstore/detail/lloccabjgblebdmncjndmiibianflabo) and [Firefox Addons](https://addons.mozilla.org/firefox/addon/reading_list/).

![Chrome Reading List extension](images/search-screenshot.png)

## Features

This is a from-scratch rewrite of the original extension — Manifest V3, TypeScript, and Lit web components instead of the original's Manifest V2 and vanilla JS.

**Carried over from the original:**

- Nifty animations
- Search
- Syncing with Google/Mozilla accounts
- A light and dark theme
- Context menu
- Open in new tab option
- Import/export
- Extension icon badge for pages already on your list
- Sort by date/title, filter by read/unread
- Inline title editing
- Drag-and-drop manual reordering
- Firefox sidebar panel

**New in this version:**

- Compressed, bucketed storage — holds several hundred+ items instead of the original's hard ~511-item limit, with no per-item key cap
- Choose where the list is stored (Options → Storage): browser sync, this device only, and/or your own server, with one primary and the rest kept as backups
- Storage Diagnostics (Options → Advanced) to check real usage against the browser's sync quota

**Not carried over:** the original's Firefox-only address-bar toggle icon (`page_action`). Chrome removed that API entirely in Manifest V3, and Firefox has long signaled intent to fold it into the unified `action` API without having done so — not worth building against something already headed for deprecation.

## Installation

Get it from the [Chrome Web Store](https://chrome.google.com/webstore/detail/lloccabjgblebdmncjndmiibianflabo) or [Firefox Addons](https://addons.mozilla.org/firefox/addon/reading_list/) for free.

### Building

Or, if you would rather do it the hard way, you can build the extension from the source code:

1. Make sure you have Node and NPM installed
1. Download/clone this repo
1. Install all the dependencies:
   ```bash
   # From the project folder
   npm install
   ```
1. Run the build command:
   ```bash
   npm run build
   ```

The build command assembles all the files in the `build` folder. After it’s built, you can load it into Chrome or Firefox.

#### Load into Chrome

1. Go to [chrome://extensions/](chrome://extensions/)
1. Check “Developer Mode”
1. Click “Load unpacked extension…”
1. Load up the “build” folder

Chrome doesn’t auto-reload an unpacked extension when the code changes — after rebuilding, click the reload icon (↻) on the extension’s card to pick up the new code.

#### Load into Firefox

1. Go to `about:debugging#/runtime/this-firefox`
1. Click “Load Temporary Add-on…”
1. Select `build/manifest.json` (or a packaged `.zip` built with `web-ext build`)

Firefox removes temporary add-ons when you close the browser, and doesn’t auto-reload on code changes either — after rebuilding, click “Reload” on the same entry in `about:debugging`.

## Using the extension

1. Go to a page you want to save for later
1. Click the reading list icon on the top right of your browser ![Chrome Reading List icon](extension/icons/icon32.png)
1. Click the `+` button
   - You can also right-click anywhere on the page and select “Add page to Reading List”
1. When you want to read a page you saved, open up the extension and click the reading item you want to read
   - `Control + click` or `command ⌘/windows key ⊞ + click` to open the page in a new tab
1. Done with a page? Click the `×` next to said page in your reading list, and it will magically vanish.

## Storage options

Options → Storage lists three places the reading list can be saved. Tick any combination of them and pick one as the **primary**:

- **Browser sync**: `chrome.storage.sync` / `browser.storage.sync`, synced to your Google or Mozilla account. Limited to roughly 300 items by the browser's sync quota.
- **This device only**: `chrome.storage.local`. Not synced; holds far more (about 10MB).
- **My own server**: an HTTP API you host (below).

The list is read from the primary, and every change is written to the primary first and then copied to each other ticked option as a backup. A failed backup write doesn't block the change; it's shown on the Options page and in Storage Diagnostics, and **Copy List to Backups Now** overwrites every backup with the primary's list.

Saving a new selection never deletes anything. The current list is merged (by URL) with whatever the newly selected options already hold, and that merged list is written to each of them. An option you untick keeps its data; it just stops being read or written.

The storage selection is kept per browser profile in `chrome.storage.local`, so each device chooses independently.

### Your own server API

Enter the base URL (for example `https://example.com/reading-list`) and an optional access token. When you save, the browser asks for permission to reach that site. The extension calls these endpoints, relative to the base URL:

| Method | Path | Body | Expected response |
| --- | --- | --- | --- |
| `GET` | `/items` | — | `200` with a JSON array of items |
| `POST` | `/items` | JSON array of items | any `2xx`; add each item, or replace the existing item with the same `url` |
| `POST` | `/items/delete` | `{ "urls": ["https://..."] }` | any `2xx`; remove items with those URLs |
| `PUT` | `/items` | JSON array of items | any `2xx`; replace the whole list (an empty array clears it) |

An item looks like this (`favIconUrl`, `viewed` and `index` are optional):

```json
{
  "url": "https://example.com/article",
  "title": "An article",
  "addedAt": 1767225600000,
  "favIconUrl": "https://example.com/favicon.ico",
  "viewed": false,
  "index": -3
}
```

Items are identified by `url`. Store every field you receive and return it unchanged. If a token is set, every request carries `Authorization: Bearer <token>`. Any non-`2xx` response, or no response within 15 seconds, counts as a failed write.
