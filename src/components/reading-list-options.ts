import { html, LitElement } from 'lit';
import { query, state } from 'lit/decorators.js';
import { BackendFailure, rl } from '../lib/rl.js';
import {
  getSettings,
  updateSettings,
  onSettingsChanged,
} from '../lib/settings.js';
import { message } from '../lib/browser.js';
import { getStorageDiagnostics } from '../lib/storage/diagnostics.js';
import { readItemsWithoutWriting } from '../lib/storage/load.js';
import {
  BackupWriteError,
  getBackupWriteError,
  getLocalBackup,
} from '../lib/storage/local-backup.js';
import { apiItemsUrl } from '../lib/storage/api-backend.js';
import {
  BACKEND_IDS,
  BackendId,
  getStorageConfig,
  StorageConfig,
} from '../lib/storage/config.js';
import { flatStore } from '../lib/storage/flat-store.js';
import { ListItemData } from '../lib/storage/store.js';
import { styles } from '../styles/options.styles.js';
import { theme } from '../styles/theme.styles.js';
import { reset } from '../styles/reset.styles.js';

type CheckboxSettingKey = 'openNewTab' | 'animateItems' | 'addContextMenu';

const CHECKBOX_SETTINGS: { key: CheckboxSettingKey; label: string }[] = [
  { key: 'openNewTab', label: 'Open items in new tab by default' },
  { key: 'animateItems', label: 'Animate items' },
  {
    key: 'addContextMenu',
    label: 'Show "Add to Reading List" in the right-click menu',
  },
];

const BACKEND_LABELS: Record<BackendId, { label: string; detail: string }> = {
  sync: {
    label: 'Browser sync',
    detail: 'Synced to your browser account. Limited to roughly 300 items.',
  },
  local: {
    label: 'This device only',
    detail: 'Kept in this browser on this computer. Not synced.',
  },
  api: {
    label: 'My own server',
    detail: 'Read and written through an API you host (see the README).',
  },
};

const describeFailures = (failures: BackendFailure[]) =>
  failures
    .map(({ backend, error }) => `${BACKEND_LABELS[backend].label}: ${error}`)
    .join('\n');

export class ReadingListOptions extends LitElement {
  static override styles = [theme, reset, styles];

  @state() settings: Record<CheckboxSettingKey, boolean> = {
    openNewTab: false,
    animateItems: true,
    addContextMenu: true,
  };

  @state() private _storage: StorageConfig | null = null;
  @state() private _storageStatus = '';
  @state() private _storageBusy = false;
  @state() private _backupError: BackupWriteError | null = null;
  @state() private _diagnostics = '';
  @state() private _diagnosticsCopied = false;
  @query('#importInput') private _importInput?: HTMLInputElement;

  private _unsubscribeSettings?: () => void;

  override connectedCallback() {
    super.connectedCallback();
    void this._loadSettings();
    void this._loadStorage();
    this._unsubscribeSettings?.();
    this._unsubscribeSettings = onSettingsChanged((settings) => {
      this.settings = {
        openNewTab: settings.openNewTab,
        animateItems: settings.animateItems,
        addContextMenu: settings.addContextMenu,
      };
    });
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribeSettings?.();
    this._unsubscribeSettings = undefined;
  }

  override render() {
    return html`
      <h2>Reading List Options</h2>

      <div class="section">
        <h3>Default Behavior</h3>
        ${CHECKBOX_SETTINGS.map(
          ({ key, label }) => html`
            <div class="option">
              <input
                type="checkbox"
                id=${key}
                ?checked=${this.settings[key]}
                @change=${(e: Event) => this._onSettingChange(key, e)}
              />
              <label for=${key}>${label}</label>
            </div>
          `,
        )}
      </div>

      ${this._renderStorage()}

      <div class="section">
        <h3>Backup & Restore</h3>
        <button @click=${this.exportList}>Export Reading List</button>
        <input
          id="importInput"
          type="file"
          accept="application/json"
          style="display:none"
          @change=${this.importList}
        />
        <button @click=${this.openImportDialog}>Import Reading List</button>
      </div>

      <details class="section">
        <summary>Advanced</summary>
        <div>
          <button @click=${this._onDiagnosticsClick}>
            Storage Diagnostics
          </button>
          <button @click=${this._onDownloadLocalBackupClick}>
            Download Local Backup
          </button>
          <button class="danger" @click=${this._onResetClick}>
            ${message('clearData', 'Clear Reading List')}
          </button>
        </div>
        ${
          this._diagnostics
            ? html`
                <div class="diagnostics">
                  <p>
                    Contains counts and sizes only - no page addresses or titles
                    - so it's safe to send in a bug report.
                  </p>
                  <button @click=${this._onCopyDiagnosticsClick}>
                    ${this._diagnosticsCopied ? 'Copied' : 'Copy to Clipboard'}
                  </button>
                  <pre>${this._diagnostics}</pre>
                </div>
              `
            : ''
        }
      </details>
    `;
  }

  private _renderStorage() {
    const config = this._storage;
    if (!config) return '';
    const hasBackups = BACKEND_IDS.some(
      (id) => id !== config.primary && config.enabled[id],
    );
    return html`
      <div class="section">
        <h3>Storage</h3>
        <p class="hint">
          Tick every place the list should be saved, and pick which one is the
          primary. The list is read from the primary; every change is also
          copied to the others as backups.
        </p>
        <table class="storage">
          <thead>
            <tr>
              <th>Use</th>
              <th>Primary</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${BACKEND_IDS.map(
              (id) => html`
                <tr>
                  <td>
                    <input
                      type="checkbox"
                      id="use-${id}"
                      .checked=${config.enabled[id]}
                      ?disabled=${id === config.primary}
                      @change=${(e: Event) =>
                        this._editStorage({
                          enabled: {
                            ...config.enabled,
                            [id]: (e.target as HTMLInputElement).checked,
                          },
                        })}
                    />
                  </td>
                  <td>
                    <input
                      type="radio"
                      name="primary"
                      .checked=${config.primary === id}
                      @change=${() =>
                        this._editStorage({
                          primary: id,
                          enabled: { ...config.enabled, [id]: true },
                        })}
                    />
                  </td>
                  <td>
                    <label for="use-${id}">${BACKEND_LABELS[id].label}</label>
                    <div class="hint">${BACKEND_LABELS[id].detail}</div>
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>
        ${
          config.enabled.api
            ? html`
                <div class="api-fields">
                  <label>
                    Server URL
                    <input
                      type="url"
                      placeholder="https://example.com/reading-list"
                      .value=${config.apiUrl}
                      @input=${(e: Event) =>
                        this._editStorage({
                          apiUrl: (e.target as HTMLInputElement).value,
                        })}
                    />
                  </label>
                  <label>
                    Access token (optional)
                    <input
                      type="password"
                      autocomplete="off"
                      .value=${config.apiToken}
                      @input=${(e: Event) =>
                        this._editStorage({
                          apiToken: (e.target as HTMLInputElement).value,
                        })}
                    />
                  </label>
                </div>
              `
            : ''
        }
        <div>
          <button
            ?disabled=${this._storageBusy}
            @click=${this._onSaveStorageClick}
          >
            Save Storage Settings
          </button>
          ${
            hasBackups
              ? html`<button
                  ?disabled=${this._storageBusy}
                  @click=${this._onCopyToBackupsClick}
                >
                  Copy List to Backups Now
                </button>`
              : ''
          }
        </div>
        ${
          this._storageStatus
            ? html`<p class="status">${this._storageStatus}</p>`
            : ''
        }
        ${
          this._backupError
            ? html`<p class="status">
                Last backup write failed
                (${
                  BACKEND_LABELS[this._backupError.backend as BackendId]
                    ?.label ?? this._backupError.backend
                },
                ${new Date(this._backupError.occurredAt).toLocaleString()}):
                ${this._backupError.message}
              </p>`
            : ''
        }
      </div>
    `;
  }

  private _editStorage(changes: Partial<StorageConfig>) {
    this._storage = { ...this._storage!, ...changes };
    this._storageStatus = '';
  }

  private async _loadStorage() {
    this._storage = await getStorageConfig();
    this._backupError = await getBackupWriteError();
  }

  private async _onSaveStorageClick() {
    const config = this._storage!;
    // permissions.request must run first, while the click still counts as a
    // user gesture.
    const granted = config.enabled.api
      ? this._requestApiPermission(config.apiUrl)
      : Promise.resolve(true);
    this._storageBusy = true;
    this._storageStatus = 'Saving...';
    try {
      if (!(await granted)) {
        throw new Error('Permission to reach the server was not granted');
      }
      const failures = await rl.changeStorage(config);
      this._storageStatus = failures.length
        ? `Saved, but some backups couldn't be written:\n${describeFailures(failures)}`
        : 'Saved.';
    } catch (err) {
      this._storageStatus = `Not saved: ${err}`;
    } finally {
      this._storageBusy = false;
      await this._loadStorage();
    }
  }

  private _requestApiPermission(apiUrl: string): Promise<boolean> {
    let origin: string;
    try {
      origin = new URL(apiItemsUrl(apiUrl)).origin;
    } catch {
      return Promise.reject(new Error('The server URL is not a valid URL'));
    }
    return chrome.permissions.request({ origins: [`${origin}/*`] });
  }

  private async _onCopyToBackupsClick() {
    this._storageBusy = true;
    this._storageStatus = 'Copying...';
    try {
      const failures = await rl.copyToBackups();
      this._storageStatus = failures.length
        ? `Some backups couldn't be written:\n${describeFailures(failures)}`
        : 'Every backup now matches the primary.';
    } catch (err) {
      this._storageStatus = `Copy failed: ${err}`;
    } finally {
      this._storageBusy = false;
      this._backupError = await getBackupWriteError();
    }
  }

  private async _loadSettings() {
    const settings = await getSettings();
    this.settings = {
      openNewTab: settings.openNewTab,
      animateItems: settings.animateItems,
      addContextMenu: settings.addContextMenu,
    };
  }

  private async _onSettingChange(key: CheckboxSettingKey, e: Event) {
    const checked = (e.target as HTMLInputElement).checked;
    this.settings = { ...this.settings, [key]: checked };
    await updateSettings({ [key]: checked });
  }

  async _onResetClick() {
    if (
      confirm(
        message(
          'confirmMsg',
          'You are about to delete everything in the reading list. Are you sure?',
        ),
      )
    ) {
      try {
        await rl.clearAll();
      } catch (err) {
        alert('Failed to clear: ' + err);
      }
    }
  }

  async _onDiagnosticsClick() {
    this._diagnosticsCopied = false;
    try {
      this._diagnostics = await getStorageDiagnostics();
    } catch (err) {
      this._diagnostics = `Storage Diagnostics itself failed: ${err}`;
    }
  }

  async _onCopyDiagnosticsClick() {
    await navigator.clipboard.writeText(this._diagnostics);
    this._diagnosticsCopied = true;
  }

  async _onDownloadLocalBackupClick() {
    const backup = await getLocalBackup();
    if (!backup) {
      alert(
        'No local backup found yet. One is saved automatically before the extension migrates data from an older version.',
      );
      return;
    }
    downloadJson('reading-list-backup.json', backup.items);
  }

  openImportDialog() {
    this._importInput?.click();
  }

  async importList(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const items: ListItemData[] | null = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object'
          ? flatStore.readItems(parsed)
          : null;

      if (items) {
        const { succeeded, firstError, diagnostics } =
          await rl.bulkAddReadingItems(items);
        if (succeeded === items.length) {
          alert(`Import complete! Added ${succeeded} items.`);
        } else {
          alert(
            `Imported ${succeeded} of ${items.length} items. ` +
              `${items.length - succeeded} failed` +
              (firstError ? ` (first error: ${firstError})` : '') +
              (diagnostics ? `\n\nDiagnostics: ${diagnostics}` : ''),
          );
        }
      } else {
        alert('Invalid file format.');
      }
    } catch (err) {
      alert('Failed to import: ' + err);
    }
    input.value = '';
  }

  async exportList() {
    const config = await getStorageConfig();
    const items =
      config.primary === 'sync'
        ? await readItemsWithoutWriting()
        : await rl.getListItems();
    downloadJson('reading-list.json', items);
  }
}

function downloadJson(filename: string, data: unknown): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 100);
}

customElements.define('reading-list-options', ReadingListOptions);
