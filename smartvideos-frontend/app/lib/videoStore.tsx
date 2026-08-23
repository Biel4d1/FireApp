import React, { createContext, useCallback, useContext, useReducer, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AuthContext } from './auth';

type VideoRecord = Record<string, any>;

type State = {
  byId: Record<number, VideoRecord>;
};

type Action =
  | { type: 'SET_VIDEOS'; payload: VideoRecord[] }
  | { type: 'UPDATE_VIDEO'; payload: { id: number; patch: Partial<VideoRecord> } }
  | { type: 'HYDRATE'; payload: Record<number, VideoRecord> }
  | { type: 'CLEAR' };

const initialState: State = { byId: {} };
const STORAGE_KEY = 'VIDEO_STORE_STATE';
const USER_ID_KEY = 'VIDEO_STORE_USER_ID';

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'SET_VIDEOS': {
      const next: Record<number, VideoRecord> = { ...state.byId };
      for (const v of action.payload) {
        if (!v || typeof v.id === 'undefined') continue;
        next[v.id] = { ...(next[v.id] || {}), ...v };
      }
      return { byId: next };
    }
    case 'UPDATE_VIDEO': {
      const { id, patch } = action.payload;
      const curr = state.byId[id] || {};
      return { byId: { ...state.byId, [id]: { ...curr, ...patch } } };
    }
    case 'HYDRATE': {
      return { byId: action.payload };
    }
    case 'CLEAR': {
      return { byId: {} };
    }
    default:
      return state;
  }
}

const VideoStoreContext = createContext<{
  state: State;
  setVideos: (videos: VideoRecord[]) => void;
  updateVideo: (id: number, patch: Partial<VideoRecord>) => void;
  getVideo: (id: number) => VideoRecord | undefined;
  clearVideos: () => void;
} | null>(null);

export function VideoStoreProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const authContext = useContext(AuthContext);

  // Hydrate from AsyncStorage on mount
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(STORAGE_KEY);
        if (mounted && stored) {
          const parsed = JSON.parse(stored);
          dispatch({ type: 'HYDRATE', payload: parsed });
          try { console.log('✓ Hydrated video store from AsyncStorage'); } catch (e) {}
        }
      } catch (e) {
        try { console.warn('Failed to hydrate video store:', e); } catch (e2) {}
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Clear video store when user changes (logout or login as different user)
  useEffect(() => {
    (async () => {
      try {
        const storedUserId = await AsyncStorage.getItem(USER_ID_KEY);
        const currentUserId = authContext?.user?.id ? String(authContext.user.id) : null;
        
        // If user changed, clear the store
        if (storedUserId && currentUserId && storedUserId !== currentUserId) {
          try { console.log('✓ User changed, clearing video store cache'); } catch (e) {}
          dispatch({ type: 'CLEAR' });
          await AsyncStorage.removeItem(STORAGE_KEY);
        }
        
        // Update stored user ID
        if (currentUserId) {
          await AsyncStorage.setItem(USER_ID_KEY, currentUserId);
        } else if (storedUserId) {
          // User logged out, clear the store
          try { console.log('✓ User logged out, clearing video store cache'); } catch (e) {}
          dispatch({ type: 'CLEAR' });
          await AsyncStorage.removeItem(STORAGE_KEY);
          await AsyncStorage.removeItem(USER_ID_KEY);
        }
      } catch (e) {
        try { console.warn('Failed to check user change:', e); } catch (e2) {}
      }
    })();
  }, [authContext?.user?.id]);

  // Persist to AsyncStorage whenever state changes
  useEffect(() => {
    (async () => {
      try {
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state.byId));
      } catch (e) {
        try { console.warn('Failed to persist video store:', e); } catch (e2) {}
      }
    })();
  }, [state.byId]);

  const setVideos = useCallback((videos: VideoRecord[]) => {
    dispatch({ type: 'SET_VIDEOS', payload: videos });
  }, []);

  const updateVideo = useCallback((id: number, patch: Partial<VideoRecord>) => {
    dispatch({ type: 'UPDATE_VIDEO', payload: { id, patch } });
  }, []);

  const getVideo = useCallback((id: number) => state.byId[id], [state.byId]);

  const clearVideos = useCallback(() => {
    dispatch({ type: 'CLEAR' });
  }, []);

  return (
    <VideoStoreContext.Provider value={{ state, setVideos, updateVideo, getVideo, clearVideos }}>
      {children}
    </VideoStoreContext.Provider>
  );
}

export function useVideoStore() {
  const ctx = useContext(VideoStoreContext);
  if (!ctx) throw new Error('useVideoStore must be used within VideoStoreProvider');
  return ctx;
}

export default VideoStoreProvider;
