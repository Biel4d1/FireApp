import * as FileSystem from 'expo-file-system/legacy';
import { getToken } from './api';
import apiClient from './api';
import { Platform } from 'react-native';

export async function getPlayableUri(filename: string) {
  // On web, just return remote URL (headers work differently on web)
  if (Platform.OS === 'web') {
    const base = (apiClient.API_BASE_URL || '').replace(/\/$/, '');
    return `${base}/video/${filename}`;
  }

  try {
    const base = (apiClient.API_BASE_URL || '').replace(/\/$/, '');
    const remote = `${base}/video/${filename}`;
    const cacheDir = ((FileSystem as any).cacheDirectory) || ((FileSystem as any).documentDirectory) || '';
    const localPath = `${cacheDir}videos/${filename}`;

    const info = await FileSystem.getInfoAsync(localPath);
    if (info.exists) return info.uri;

    // ensure directory exists
    const dir = localPath.substring(0, localPath.lastIndexOf('/'));
    const dirInfo = await FileSystem.getInfoAsync(dir);
    if (!dirInfo.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });

    const token = await getToken();
    const headers: any = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await FileSystem.downloadAsync(remote, localPath, { headers });
    if (res && res.status === 200) return res.uri;
    // fallback to remote
    return remote;
  } catch (e) {
    try { console.warn('videoCache error', e); } catch (e2) {}
    const base = (apiClient.API_BASE_URL || '').replace(/\/$/, '');
    return `${base}/video/${filename}`;
  }
}

export async function clearCachedVideo(filename: string) {
  try {
    const cacheDir = ((FileSystem as any).cacheDirectory) || ((FileSystem as any).documentDirectory) || '';
    const localPath = `${cacheDir}videos/${filename}`;
    const info = await FileSystem.getInfoAsync(localPath);
    if (info.exists) await FileSystem.deleteAsync(localPath, { idempotent: true });
  } catch (e) {}
}

// default export for non-route utility usage
export default { getPlayableUri, clearCachedVideo };
