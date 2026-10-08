import { html, LitElement } from 'lit';
import { query, state } from 'lit/decorators.js';
import { rl } from '../lib/rl.js';
import {
  DEFAULT_SETTINGS,
  getSettings,
  Settings,
  updateSettings,
  onSettingsChanged,
} from '../lib/settings.js';
import { isFirefox, message } from '../lib/browser.js';
import { getStorageDiagnostics } from '../lib/storage/diagnostics.js';
import { readItemsWithoutWriting } from '../lib/storage/load.js';
import { getLocalBackup } from '../lib/storage/local-backup.js';
import { flatStore } from '../lib/storage/flat-store.js';
import { ListItemData } from '../lib/storage/store.js';
import { styles } from '../styles/options.styles.js';
import { theme } from '../styles/theme.styles.js';
import { reset } from '../styles/reset.styles.js';

const CHECKBOX_SETTINGS = [
  { key: 'openNewTab', labelKey: 'openNewTab', firefoxOnly: false },
  { key: 'animateItems', labelKey: 'animation', firefoxOnly: false },
  { key: 'addContextMenu', labelKey: 'context', firefoxOnly: false },
  { key: 'addPageAction', labelKey: 'pageActionOption', firefoxOnly: true },
] as const;

type CheckboxSettingKey = (typeof CHECKBOX_SETTINGS)[number]['key'];

function checkboxValues(settings: Required<Settings>) {
  return Object.fromEntries(
    CHECKBOX_SETTINGS.map(({ key }) => [key, settings[key]]),
  ) as Record<CheckboxSettingKey, boolean>;
}

export class ReadingListOptions extends LitElement {
  static override styles = [theme, reset, styles];

  @state() settings = checkboxValues(DEFAULT_SETTINGS);

  @state() private _diagnostics = '';
  @state() private _diagnosticsCopied = false;
  @query('#importInput') private _importInput?: HTMLInputElement;

  private _unsubscribeSettings?: () => void;

  override connectedCallback() {
    super.connectedCallback();
    document.title = message('optionsTitle');
    void this._loadSettings();
    this._unsubscribeSettings?.();
    this._unsubscribeSettings = onSettingsChanged((settings) => {
      this.settings = checkboxValues(settings);
    });
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribeSettings?.();
    this._unsubscribeSettings = undefined;
  }

  override render() {
    return html`
      <h2>${message('optionsTitle')}</h2>

      <div class="section">
        <h3>${message('defaultBehavior')}</h3>
        ${CHECKBOX_SETTINGS.filter(
          ({ firefoxOnly }) => !firefoxOnly || isFirefox,
        ).map(
          ({ key, labelKey }) => html`
            <div class="option">
              <input
                type="checkbox"
                id=${key}
                ?checked=${this.settings[key]}
                @change=${(e: Event) => this._onSettingChange(key, e)}
              />
              <label for=${key}>${message(labelKey)}</label>
            </div>
          `,
        )}
      </div>

      <div class="section">
        <h3>${message('backupRestore')}</h3>
        <button @click=${this.exportList}>${message('export')}</button>
        <input
          id="importInput"
          type="file"
          accept="application/json"
          style="display:none"
          @change=${this.importList}
        />
        <button @click=${this.openImportDialog}>${message('import')}</button>
      </div>

      <details class="section">
        <summary>${message('advancedOptions')}</summary>
        <div>
          <button @click=${this._onDiagnosticsClick}>
            ${message('storageDiagnostics')}
          </button>
          <button @click=${this._onDownloadLocalBackupClick}>
            ${message('downloadLocalBackup')}
          </button>
          <button class="danger" @click=${this._onResetClick}>
            ${message('clearData')}
          </button>
        </div>
        ${
          this._diagnostics
            ? html`
                <div class="diagnostics">
                  <p>${message('diagnosticsNote')}</p>
                  <button @click=${this._onCopyDiagnosticsClick}>
                    ${message(
                      this._diagnosticsCopied ? 'copied' : 'copyToClipboard',
                    )}
                  </button>
                  <pre>${this._diagnostics}</pre>
                </div>
              `
            : ''
        }
      </details>
    `;
  }

  private async _loadSettings() {
    const settings = await getSettings();
    this.settings = checkboxValues(settings);
  }

  private async _onSettingChange(key: CheckboxSettingKey, e: Event) {
    const checked = (e.target as HTMLInputElement).checked;
    this.settings = { ...this.settings, [key]: checked };
    await updateSettings({ [key]: checked });
  }

  async _onResetClick() {
    if (confirm(message('confirmMsg'))) {
      await rl.clearAll();
    }
  }

  async _onDiagnosticsClick() {
    this._diagnosticsCopied = false;
    try {
      this._diagnostics = await getStorageDiagnostics();
    } catch (err) {
      this._diagnostics = message('diagnosticsFailed', String(err));
    }
  }

  async _onCopyDiagnosticsClick() {
    await navigator.clipboard.writeText(this._diagnostics);
    this._diagnosticsCopied = true;
  }

  async _onDownloadLocalBackupClick() {
    const backup = await getLocalBackup();
    if (!backup) {
      alert(message('noLocalBackup'));
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
          alert(message('importComplete', String(succeeded)));
        } else {
          alert(
            message('importPartial', [
              String(succeeded),
              String(items.length),
              String(items.length - succeeded),
            ]) +
              (firstError
                ? ` ${message('importFirstError', String(firstError))}`
                : '') +
              (diagnostics
                ? `\n\n${message('importDiagnostics', String(diagnostics))}`
                : ''),
          );
        }
      } else {
        alert(message('importInvalidFile'));
      }
    } catch (err) {
      alert(message('importFailed', String(err)));
    }
    input.value = '';
  }

  async exportList() {
    downloadJson('reading-list.json', await readItemsWithoutWriting());
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
