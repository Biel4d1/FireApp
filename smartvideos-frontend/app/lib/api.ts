import axios from 'axios';
import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'SV_TOKEN';

// Change this constant to point to your backend, e.g. http://192.168.1.5:5000
// Replace with the URL returned by `npx localtunnel --port 8000` (example: https://funny-bears-jump.loca.lt)
// Backend listens on port 5000 by default; include the port so requests reach the server on the LAN
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'https://api.smartvideos.lat';

// Set global axios defaults so all requests include the localtunnel reminder header
axios.defaults.headers = axios.defaults.headers || ({} as any);
axios.defaults.headers.common = axios.defaults.headers.common || {};
axios.defaults.headers.common['Content-Type'] = axios.defaults.headers.common['Content-Type'] || 'application/json';
axios.defaults.headers.common['Accept'] = axios.defaults.headers.common['Accept'] || 'application/json';

export function getApiClient(token?: string, timeoutMs: number = 10000) {
  const base = (API_BASE_URL || '').toString().trim();
  try { console.log('getApiClient using base:', base); } catch (e) {}
  const instance = axios.create({
    baseURL: base,
    timeout: timeoutMs,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  });

  // also set on defaults to ensure lower-level XHR sends it
  try {
    instance.defaults.headers = instance.defaults.headers || ({} as any);
    instance.defaults.headers.common = instance.defaults.headers.common || {};
    instance.defaults.headers.common['Content-Type'] = instance.defaults.headers.common['Content-Type'] || 'application/json';
    instance.defaults.headers.common['Accept'] = instance.defaults.headers.common['Accept'] || 'application/json';
  } catch (e) {}

  if (token) instance.defaults.headers.common['Authorization'] = `Bearer ${token}`;

  // Ensure every request has JSON headers and attach auth token from SecureStore when available
  try {
    instance.interceptors.request.use(async (config: any) => {
      try {
        config.headers = config.headers || {};
        // Detect FormData-like payloads (expo / react-native FormData may not be an instanceof FormData)
        const isFormData = config.data && typeof config.data.append === 'function';
        if (isFormData) {
          // Let the underlying XHR/fetch set the proper multipart Content-Type with boundary
          try { delete config.headers['Content-Type']; } catch (e) {}
        } else {
          config.headers['Content-Type'] = config.headers['Content-Type'] || 'application/json';
        }
        config.headers['Accept'] = config.headers['Accept'] || 'application/json';
        if (!config.headers['Authorization']) {
          const stored = await SecureStore.getItemAsync(TOKEN_KEY);
          if (stored) config.headers['Authorization'] = `Bearer ${stored}`;
        }
      } catch (e) {}
      return config;
    }, (err: any) => Promise.reject(err));
  } catch (e) {}

  // expose base url for Video URIs
  // @ts-ignore
  instance.baseUrl = base;

  return instance;
}

// Provide a default export so expo-router doesn't treat this file as a route component
export default { API_BASE_URL, getApiClient };

export async function saveToken(token: string) {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function getToken(): Promise<string | null> {
  return await SecureStore.getItemAsync(TOKEN_KEY);
}

export async function removeToken() {
  return SecureStore.deleteItemAsync(TOKEN_KEY);
}

export async function login(username: string, password: string) {
  const client = getApiClient();
  return client.post('/login', { username, password });
}

export async function signup(username: string, password: string) {
  const client = getApiClient();
  return client.post('/signup', { username, password });
}

export async function toggleLike(video_id: number) {
  try {
    const token = await getToken();
    const client = getApiClient(token ?? undefined);
    const resp = await client.post('/toggle_like', { video_id });
    const data = resp?.data || {};
    // normalize response keys
    return {
      is_liked: data.is_liked ?? data.isLiked ?? data.liked ?? false,
      likes_count: data.likes_count ?? data.likesCount ?? data.likes ?? null,
      is_disliked: data.is_disliked ?? data.isDisliked ?? data.disliked ?? false,
      dislikes_count: data.dislikes_count ?? data.dislikesCount ?? data.dislikes ?? null,
      raw: data,
    };
  } catch (e) {
    throw e;
  }
}

export async function toggleDislike(video_id: number) {
  try {
    const token = await getToken();
    const client = getApiClient(token ?? undefined);
    const resp = await client.post('/toggle_dislike', { video_id });
    const data = resp?.data || {};
    return {
      is_disliked: data.is_disliked ?? data.isDisliked ?? data.disliked ?? false,
      dislikes_count: data.dislikes_count ?? data.dislikesCount ?? data.dislikes ?? null,
      is_liked: data.is_liked ?? data.isLiked ?? data.liked ?? false,
      likes_count: data.likes_count ?? data.likesCount ?? data.likes ?? null,
      raw: data,
    };
  } catch (e) {
    throw e;
  }
}

export async function recordInteraction(video_id: number, watch_time: number, is_liked: boolean = false, is_commented: boolean = false) {
  // Resolve current user id from stored token and POST to backend
  try {
    const token = await getToken();
    const user_id = decodeTokenUserId(token || undefined);
    if (!user_id) throw new Error('no authenticated user');
    const client = getApiClient(token ?? undefined);
    return await client.post('/record_interaction', {
      user_id: user_id,
      video_id: video_id,
      watch_time_ms: Math.max(0, Math.floor(watch_time || 0)),
      is_liked: is_liked ? 1 : 0,
      is_commented: is_commented ? 1 : 0
    });
  } catch (e) {
    // bubble up so callers may handle/log if desired
    throw e;
  }
}

export function decodeTokenUserId(token?: string): number | null {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = parts[1];
    let jsonStr = '';
    if (typeof atob === 'function') {
      jsonStr = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    } else if (typeof Buffer !== 'undefined') {
      jsonStr = Buffer.from(payload, 'base64').toString();
    } else if ((globalThis as any)?.Buffer) {
      jsonStr = (globalThis as any).Buffer.from(payload, 'base64').toString();
    } else {
      return null;
    }
    const obj = JSON.parse(jsonStr);
    return obj.user_id ?? null;
  } catch (e) {
    return null;
  }
}

// ---------- New API helpers ----------

export async function deleteVideo(id: number) {
  try {
    const token = await getToken();
    const client = getApiClient(token ?? undefined);
    // backend route: DELETE /delete_video/<id>
    const resp = await client.delete(`/delete_video/${id}`);
    return resp.data;
  } catch (e) {
    throw e;
  }
}

export async function deleteComment(id: number) {
  try {
    const token = await getToken();
    const client = getApiClient(token ?? undefined);
    // backend route: DELETE /delete_comment/<id>
    const resp = await client.delete(`/delete_comment/${id}`);
    return resp.data;
  } catch (e) {
    throw e;
  }
}

export async function reportVideo(video_id: number, reason: string) {
  try {
    const token = await getToken();
    const client = getApiClient(token ?? undefined);
    const resp = await client.post('/report_video', { video_id, reason });
    return resp.data;
  } catch (e) {
    throw e;
  }
}

export async function reportUser(reported_user_id: number, reason: string) {
  try {
    const token = await getToken();
    const client = getApiClient(token ?? undefined);
    const resp = await client.post('/report_user', { reported_user_id, reason });
    return resp.data;
  } catch (e) {
    throw e;
  }
}

export async function deleteAccount(password: string) {
  try {
    const token = await getToken();
    const client = getApiClient(token ?? undefined);
    // axios DELETE with body requires `data` option
    const resp = await client.delete('/delete_account', { data: { password } });
    // remove local token on success
    try {
      await removeToken();
    } catch (e) {}
    return resp.data;
  } catch (e) {
    throw e;
  }
}

export async function searchContent(query: string) {
  try {
    const token = await getToken();
    const baseURL = (process.env.EXPO_PUBLIC_API_URL || 'http://localhost:5000').replace(/\/$/, '');
    const res = await fetch(`${baseURL}/search?q=${encodeURIComponent(query)}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } catch (e: any) {
    console.error('searchContent failed:', e);
    throw e;
  }
}
