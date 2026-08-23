import React, { createContext, useCallback, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getToken as getStoredToken, saveToken as storeToken, removeToken as removeStoredToken, getApiClient } from './api';

const TOKEN_KEY = 'SV_TOKEN';

type AuthContextType = {
  isAuthenticated: boolean;
  token: string | null;
  loading: boolean;
  signIn: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
  user: any | null;
  setUser: (u: any | null) => void;
  refreshUser: () => Promise<void>;
};

export const AuthContext = createContext<AuthContextType>({
  isAuthenticated: false,
  token: null,
  loading: true,
  signIn: async () => {},
  signOut: async () => {},
  user: null,
  setUser: () => {},
  refreshUser: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        // Prefer token stored in AsyncStorage for quicker app startup
        const stored = await AsyncStorage.getItem('userToken');
        
        // If token exists, validate it against /me endpoint before setting it
        if (stored) {
          try {
            const client = getApiClient(stored);
            const resp = await client.get('/me', { timeout: 5000 });
            if (mounted) {
              // Token is valid, set it and restore user
              setToken(stored);
              setUser(resp.data?.user ?? null);
              try { console.log('✓ Restored valid user token and profile from AsyncStorage:', resp.data?.user?.username); } catch (e) {}
            }
            setLoading(false);
            return;
          } catch (e: any) {
            // Token validation failed, clear it
            try { console.warn('Token validation failed on app startup, clearing auth'); } catch (e2) {}
            try { await removeStoredToken(); } catch (e2) {}
            try { await AsyncStorage.multiRemove(['userToken', 'userProfile']); } catch (e2) {}
          }
        }

        // hydrate user if previously cached (only if no token)
        if (!stored) {
          try {
            const cachedUser = await AsyncStorage.getItem('userProfile');
            if (mounted && cachedUser) {
              const parsed = JSON.parse(cachedUser);
              setUser(parsed);
              try { console.log('✓ Restored user profile from AsyncStorage:', parsed?.username); } catch (e) {}
            }
          } catch (e) {
            try { console.warn('Failed to restore user profile:', e); } catch (e2) {}
          }

          // If no token in AsyncStorage, try SecureStore (legacy backup)
          try {
            const secureToken = await getStoredToken();
            if (mounted && secureToken) {
              // Validate secure token too
              try {
                const client = getApiClient(secureToken);
                const resp = await client.get('/me', { timeout: 5000 });
                setToken(secureToken);
                setUser(resp.data?.user ?? null);
                try { console.log('✓ Restored valid user token from SecureStore'); } catch (e) {}
                setLoading(false);
                return;
              } catch (e: any) {
                try { console.warn('SecureStore token validation failed, clearing'); } catch (e2) {}
                try { await removeStoredToken(); } catch (e2) {}
              }
            }
          } catch (e) {
            try { console.warn('SecureStore check error:', e); } catch (e2) {}
          }
        }
      } catch (e) {
        try { console.warn('Token restoration error:', e); } catch (e2) {}
      } finally {
        if (mounted) {
          setLoading(false);
          try { console.log('✓ Auth initialization complete'); } catch (e) {}
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // whenever token changes, fetch the current user and store in context (for external token updates)
  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!token) return;
      try {
        const apiClient = getApiClient(token);
        const resp = await apiClient.get('/me');
        if (mounted) setUser(resp.data?.user ?? null);
      } catch (e) {
        if (mounted) setUser(null);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [token]);


  const signIn = useCallback(async (t: string) => {
    try {
      // Persist token both in SecureStore (safe) and AsyncStorage (quick restore)
      await storeToken(t);
      try { console.log('✓ Token stored in SecureStore'); } catch (e) {}
    } catch (e) {
      try { console.error('Failed to store token in SecureStore:', e); } catch (e2) {}
    }
    
    try {
      await AsyncStorage.setItem('userToken', t);
      try { console.log('✓ Token stored in AsyncStorage'); } catch (e) {}
    } catch (e) {
      try { console.error('Failed to store token in AsyncStorage:', e); } catch (e2) {}
    }
    
    setToken(t);

    // fetch and cache the current user immediately so UI can update
    try {
      const resp = await getApiClient().get('/me');
      const u = resp?.data?.user ?? null;
      setUser(u);
      try {
        if (u) {
          await AsyncStorage.setItem('userProfile', JSON.stringify(u));
          try { console.log('✓ User profile cached:', u?.username); } catch (e) {}
        }
      } catch (e) {
        try { console.error('Failed to cache user profile:', e); } catch (e2) {}
      }
    } catch (e) {
      try { console.error('Failed to fetch user profile after login:', e); } catch (e2) {}
      // continue even if fetch fails; token-effect will attempt again
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await removeStoredToken();
      try { console.log('✓ Token removed from SecureStore'); } catch (e) {}
    } catch (e) {
      try { console.error('Failed to remove token from SecureStore:', e); } catch (e2) {}
    }
    
    try {
      await AsyncStorage.multiRemove(['userToken', 'userProfile']);
      try { console.log('✓ Token and profile removed from AsyncStorage'); } catch (e) {}
    } catch (e) {
      try { console.error('Failed to remove from AsyncStorage:', e); } catch (e2) {}
    }
    
    setToken(null);
    try {
      setUser(null);
    } catch (e) {}
  }, []);

  // Expose a method to manually refresh the user data from the server
  const refreshUser = useCallback(async () => {
    try {
      if (!token) return;
      const resp = await getApiClient().get('/me');
      const updatedUser = resp.data?.user ?? null;
      setUser(updatedUser);
      // Also update cached profile
      try {
        if (updatedUser) {
          await AsyncStorage.setItem('userProfile', JSON.stringify(updatedUser));
          try { console.log('✓ User profile refreshed:', updatedUser?.username); } catch (e) {}
        }
      } catch (e) {
        try { console.error('Failed to cache refreshed user profile:', e); } catch (e2) {}
      }
    } catch (e: any) {
      // If the backend reports an unauthorized error, immediately sign out
      try {
        const status = e?.response?.status;
        if (status === 401) {
          try { console.warn('refreshUser: token rejected by server (401), signing out'); } catch (e2) {}
          await signOut();
          return;
        }
      } catch (inner) {
        try { console.error('Error while handling refreshUser failure:', inner); } catch (e2) {}
      }

      try { console.error('Failed to refresh user profile:', e); } catch (e2) {}
    }
  }, [token, signOut]);

  return (
    <AuthContext.Provider value={{ isAuthenticated: !!token, token, loading, signIn, signOut, user, setUser, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export default AuthProvider;
