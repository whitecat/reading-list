import type { Backend } from './backend.js';
import { StorageConfig } from './config.js';
import { ListItemData } from './store.js';

const API_TIMEOUT_MS = 15000;

export const apiItemsUrl = (baseUrl: string, path = '') =>
  `${baseUrl.trim().replace(/\/+$/, '')}/items${path}`;

export function apiBackend(config: StorageConfig): Backend {
  async function request(
    method: string,
    path = '',
    body?: unknown,
  ): Promise<Response> {
    if (!config.apiUrl.trim()) throw new Error('No API URL is configured');
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (config.apiToken) headers.Authorization = `Bearer ${config.apiToken}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const response = await fetch(apiItemsUrl(config.apiUrl, path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `API ${method} ${path || '/items'} failed: ${response.status} ${response.statusText}`,
        );
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async function readItems(): Promise<ListItemData[]> {
    const items: unknown = await (await request('GET')).json();
    if (!Array.isArray(items))
      throw new Error('API GET /items did not return an array');
    return items as ListItemData[];
  }

  return {
    id: 'api',
    load: readItems,
    readWithoutWriting: readItems,
    upsert: async (items) => void (await request('POST', '', items)),
    remove: async (urls) => void (await request('POST', '/delete', { urls })),
    replaceAll: async (items) => void (await request('PUT', '', items)),
    clear: async () => void (await request('PUT', '', [])),
  };
}
