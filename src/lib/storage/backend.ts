import { BackendId } from './config.js';
import { ListItemData } from './store.js';

// One place the reading list can be kept. rl.ts reads from the primary
// backend and writes every change to the primary, then to each backup.
export interface Backend {
  readonly id: BackendId;
  load(): Promise<ListItemData[]>;
  readWithoutWriting(): Promise<ListItemData[]>;
  upsert(items: ListItemData[]): Promise<void>;
  remove(urls: string[]): Promise<void>;
  replaceAll(items: ListItemData[]): Promise<void>;
  clear(): Promise<void>;
  describeFailedUpsert?(items: ListItemData[]): Promise<string>;
}
