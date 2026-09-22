import React, { createContext, useCallback, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

const API_BASE = 'https://api.smartvideos.lat';
const SECURE_TOKEN_KEY = 'gotunes_jwt_token';
const ASYNC_TOKEN_KEY = 'userToken';
const USER_PROFILE_KEY = 'userProfile';

export const AuthContext = createContext({
  isAuthenticated: false,
  token: null,
  loading: true,
  user: null,
  login: async (token) => {},
                                         logout: async () => {},
});

export function AuthProvider({ children }) {
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    const initAuth = async () => {
      let storedToken = null;

      try {
        storedToken = await AsyncStorage.getItem(ASYNC_TOKEN_KEY);
      } catch (e) {
        // Try the fallback store if AsyncStorage is unavailable.
      }

      if (!storedToken) {
        try {
          storedToken = await SecureStore.getItemAsync(SECURE_TOKEN_KEY);
        } catch (e) {
          console.error('Auth initialization error:', e);
        }
      }

      if (!mounted) return;

      if (storedToken) {
        setToken(storedToken);

        try {
          const cachedUser = await AsyncStorage.getItem(USER_PROFILE_KEY);
          if (mounted && cachedUser) {
            setUser(JSON.parse(cachedUser));
          }
        } catch (e) {}

        setLoading(false);

        // Validation must not delay startup or turn a network failure into logout.
        try {
          const res = await fetch(`${API_BASE}/me`, {
            headers: { Authorization: `Bearer ${storedToken}` },
          });

          if (res.ok) {
            const data = await res.json();
            if (mounted && data?.user) {
              setUser(data.user);
              await AsyncStorage.setItem(USER_PROFILE_KEY, JSON.stringify(data.user));
            }
          } else if (res.status === 401 || res.status === 403) {
            await removeTokens();
            if (mounted) {
              setToken(null);
              setUser(null);
            }
          }
        } catch (e) {
          // Keep the locally restored session active when the backend is unreachable.
        }
        return;
      }

      setLoading(false);
    };

    initAuth();
    return () => {
      mounted = false;
    };
  }, []);

  const removeTokens = async () => {
    try {
      await SecureStore.deleteItemAsync(SECURE_TOKEN_KEY);
    } catch (e) {}
    try {
      await AsyncStorage.multiRemove([ASYNC_TOKEN_KEY, USER_PROFILE_KEY]);
    } catch (e) {}
  };

  const login = useCallback(async (newToken) => {
    if (!newToken) return;

    await Promise.all([
      AsyncStorage.setItem(ASYNC_TOKEN_KEY, newToken),
      SecureStore.setItemAsync(SECURE_TOKEN_KEY, newToken),
    ]);

    setToken(newToken);

    // Fetch and cache user profile
    try {
      const res = await fetch(`${API_BASE}/me`, {
        headers: { Authorization: `Bearer ${newToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        const u = data?.user ?? null;
        setUser(u);
        if (u) {
          await AsyncStorage.setItem(USER_PROFILE_KEY, JSON.stringify(u));
        }
      }
    } catch (e) {}
  }, []);

  const logout = useCallback(async () => {
    await removeTokens();
    setToken(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
    value={{
      isAuthenticated: !!token,
      token,
      loading,
      user,
      login,
      logout,
    }}
    >
    {children}
    </AuthContext.Provider>
  );
}
