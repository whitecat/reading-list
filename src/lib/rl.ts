import {
  Backend,
  backendFor,
  StorageTargets,
  storageTargets,
} from './storage/backends.js';
import {
  BACKEND_IDS,
  BackendId,
  getStorageConfig,
  saveStorageConfig,
  StorageConfig,
} from './storage/config.js';
import {
  clearBackupWriteError,
  saveBackupWriteError,
} from './storage/local-backup.js';
import { ListItemData, mergeByUrl } from './storage/store.js';

const LIST_CHANGED_MESSAGE = 'reading-list:changed';
const IMPORT_BATCH_SIZE = 25;

export interface ImportResult {
  succeeded: number;
  failed: number;
  firstError: unknown;
  diagnostics: string;
}

export interface BackendFailure {
  backend: BackendId;
  error: unknown;
}

function assertHttpUrl(url: string): void {
  if (!/^https?:\/\//i.test(url))
    throw new Error(`Unsupported URL scheme: ${url}`);
}

function withoutDataFavicon(item: ListItemData): ListItemData {
  return item.favIconUrl?.startsWith('data:')
    ? { ...item, favIconUrl: undefined }
    : item;
}

function toStoredItem(item: ListItemData, index: number): ListItemData {
  assertHttpUrl(item.url);
  return { ...withoutDataFavicon(item), index };
}

const newestFirst = (a: ListItemData, b: ListItemData) => b.addedAt - a.addedAt;

class RL {
  private list: ListItemData[] = [];
  private targets: StorageTargets | null = null;
  private loaded = false;
  private reloadGeneration = 0;
  private subscribers = new Set<() => void>();

  constructor() {
    chrome?.runtime?.onMessage?.addListener((message: unknown) => {
      if (
        (message as { kind?: unknown } | null)?.kind === LIST_CHANGED_MESSAGE
      ) {
        void this.reloadAfterRemoteChange();
      }
    });
  }

  subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private async load(): Promise<ListItemData[]> {
    this.targets = storageTargets(await getStorageConfig());
    return (await this.targets.primary.load()).sort(newestFirst);
  }

  async getListItems(): Promise<ListItemData[]> {
    if (!this.loaded) {
      this.list = await this.load();
      this.loaded = true;
    }
    return this.list;
  }

  private async reloadAfterRemoteChange() {
    const generation = ++this.reloadGeneration;
    this.loaded = false;
    const items = await this.load();
    if (generation !== this.reloadGeneration) return;
    this.list = items;
    this.loaded = true;
    for (const callback of this.subscribers) callback();
  }

  private async writeBackups(
    write: (backend: Backend) => Promise<void>,
    backups = this.targets?.backups ?? [],
  ): Promise<BackendFailure[]> {
    const results = await Promise.allSettled(backups.map(write));
    const failures: BackendFailure[] = [];
    results.forEach((result, i) => {
      if (result.status === 'rejected')
        failures.push({ backend: backups[i].id, error: result.reason });
    });
    for (const { backend, error } of failures)
      await saveBackupWriteError(backend, error).catch(() => {});
    return failures;
  }

  private async write(
    write: (backend: Backend) => Promise<void>,
  ): Promise<void> {
    await write(this.targets!.primary);
    await this.writeBackups(write);
  }

  private broadcastChange() {
    void chrome?.runtime
      ?.sendMessage?.({ kind: LIST_CHANGED_MESSAGE })
      ?.catch(() => {});
  }

  private topIndex(): number {
    return Math.min(0, ...this.list.map((item) => item.index ?? 0));
  }

  private replaceItems(items: ListItemData[]) {
    const byUrl = new Map(items.map((item) => [item.url, item]));
    this.list = [
      ...[...byUrl.values()].reverse(),
      ...this.list.filter((item) => !byUrl.has(item.url)),
    ];
  }

  async addReadingItem(item: ListItemData): Promise<ListItemData> {
    await this.getListItems();
    const stored = toStoredItem(item, this.topIndex() - 1);
    await this.write((backend) => backend.upsert([stored]));
    this.replaceItems([stored]);
    this.broadcastChange();
    return stored;
  }

  async bulkAddReadingItems(rawItems: ListItemData[]): Promise<ImportResult> {
    await this.getListItems();
    const firstIndex = this.topIndex() - rawItems.length;
    let succeeded = 0;
    let firstError: unknown = null;
    let diagnostics = '';
    const written: ListItemData[] = [];
    const primary = this.targets!.primary;

    for (let start = 0; start < rawItems.length; start += IMPORT_BATCH_SIZE) {
      const batch: ListItemData[] = [];
      rawItems
        .slice(start, start + IMPORT_BATCH_SIZE)
        .forEach((raw, offset) => {
          try {
            batch.push(toStoredItem(raw, firstIndex + start + offset));
          } catch (err) {
            firstError ??= err;
          }
        });

      try {
        await primary.upsert(batch);
      } catch (err) {
        const detail = await primary
          .describeFailedUpsert?.(batch)
          .catch(() => '');
        diagnostics =
          `at item ${start}/${rawItems.length} (${primary.id} storage)` +
          (detail ? `, ${detail}` : '') +
          `, error: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
        firstError ??= err;
        break;
      }
      this.replaceItems(batch);
      written.push(...batch);
      succeeded += batch.length;
    }

    if (written.length > 0)
      await this.writeBackups((backend) => backend.upsert(written));
    if (succeeded > 0) this.broadcastChange();
    return {
      succeeded,
      failed: rawItems.length - succeeded,
      firstError,
      diagnostics,
    };
  }

  async removeReadingItem(url: string): Promise<void> {
    await this.getListItems();
    await this.write((backend) => backend.remove([url]));
    this.list = this.list.filter((item) => item.url !== url);
    this.broadcastChange();
  }

  async updateReadingItem(
    url: string,
    updates: Partial<ListItemData>,
  ): Promise<void> {
    await this.getListItems();
    const item = this.list.find((existing) => existing.url === url);
    const changesSomething = (
      Object.keys(updates) as (keyof ListItemData)[]
    ).some((key) => item?.[key] !== updates[key]);
    if (!item || !changesSomething) return;
    const updated = { ...item, ...updates };
    await this.write((backend) => backend.upsert([updated]));
    this.list = this.list.map((existing) =>
      existing.url === url ? updated : existing,
    );
    this.broadcastChange();
  }

  async reorderItems(orderedUrls: string[]): Promise<void> {
    await this.getListItems();
    const indexByUrl = new Map(orderedUrls.map((url, index) => [url, index]));
    const reordered = this.list
      .filter((item) => indexByUrl.has(item.url))
      .map((item) => ({ ...item, index: indexByUrl.get(item.url) }));
    if (reordered.length === 0) return;
    await this.write((backend) => backend.upsert(reordered));
    const reorderedByUrl = new Map(reordered.map((item) => [item.url, item]));
    this.list = this.list.map((item) => reorderedByUrl.get(item.url) ?? item);
    this.broadcastChange();
  }

  async clearAll(): Promise<void> {
    await this.getListItems();
    await this.write((backend) => backend.clear());
    this.list = [];
    this.loaded = true;
    this.broadcastChange();
  }

  async copyToBackups(): Promise<BackendFailure[]> {
    const items = await this.getListItems();
    const failures = await this.writeBackups((backend) =>
      backend.replaceAll(items),
    );
    if (failures.length === 0) await clearBackupWriteError();
    return failures;
  }

  // Switching storage never deletes anything: the new primary and every
  // enabled backup get the current list merged with whatever they held.
  async changeStorage(next: StorageConfig): Promise<BackendFailure[]> {
    const current = await this.getListItems();
    const previousPrimary = this.targets!.primary.id;
    const enabled = BACKEND_IDS.filter(
      (id) => id === next.primary || next.enabled[id],
    );
    const backends = enabled.map((id) => backendFor(id, next));

    let merged = current;
    const unreadable: BackendFailure[] = [];
    for (const backend of backends) {
      if (backend.id === previousPrimary) continue;
      try {
        merged = mergeByUrl(merged, await backend.readWithoutWriting());
      } catch (error) {
        if (backend.id === next.primary) throw error;
        unreadable.push({ backend: backend.id, error });
      }
    }

    // A backup that couldn't be read is left alone rather than overwritten.
    const needsWrite = (backend: Backend) =>
      !unreadable.some((failure) => failure.backend === backend.id) &&
      (backend.id !== previousPrimary || merged.length !== current.length);
    const primary = backends.find((backend) => backend.id === next.primary)!;
    if (needsWrite(primary)) await primary.replaceAll(merged);
    const failures = await this.writeBackups(
      (backend) => backend.replaceAll(merged),
      backends.filter((backend) => backend !== primary && needsWrite(backend)),
    );
    for (const { backend, error } of unreadable)
      await saveBackupWriteError(backend, error).catch(() => {});

    await saveStorageConfig(next);
    this.list = await this.load();
    this.loaded = true;
    this.broadcastChange();
    for (const callback of this.subscribers) callback();
    return [...unreadable, ...failures];
  }
}

export const rl = new RL();
