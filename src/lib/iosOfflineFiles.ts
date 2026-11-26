import { Capacitor, registerPlugin } from '@capacitor/core';
import type { Checkpoint, OfflineRegion } from './offlineMaps';

export const iosOffline = () => Capacitor.getPlatform() === 'ios' && Capacitor.isPluginAvailable('OfflineFiles');

export const offlineFiles = registerPlugin<{
  capacity(): Promise<{ availableBytes: number }>;
  regions(): Promise<{ entries: OfflineRegion[] }>;
  publish(options: { region: OfflineRegion; previous?: string }): Promise<void>;
  remove(options: { id: string }): Promise<void>;
  erase(options: { id: string }): Promise<void>;
  writeBatch(options: { id: string; entries: { path: string; data: string }[] }): Promise<void>;
  checkpoint(options: { key: string; entry?: Checkpoint; remove?: boolean }): Promise<{ entry?: Checkpoint }>;
  read(options: { id: string; path: string }): Promise<{ data?: string }>;
  digest(options: { data: string }): Promise<{ hash: string }>;
}>('OfflineFiles');

export function encodeBytes(buffer: ArrayBufferLike) {
  const bytes = new Uint8Array(buffer);
  let chars = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    chars += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(chars);
}

export async function readIosAsset(id: string, path: string) {
  const { data } = await offlineFiles.read({ id, path });
  return data === undefined ? undefined : Uint8Array.from(atob(data), (value) => value.charCodeAt(0)).buffer;
}

export async function writeIosAssets(id: string, entries: (readonly [string, ArrayBuffer])[], signal?: AbortSignal) {
  for (let offset = 0; offset < entries.length; offset += 16) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const batch = entries.slice(offset, offset + 16).map(([path, data]) => ({ path, data: encodeBytes(data) }));
    await offlineFiles.writeBatch({ id, entries: batch });
  }
}
