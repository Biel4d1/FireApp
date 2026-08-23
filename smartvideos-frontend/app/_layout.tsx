import React from 'react';
import { Stack } from 'expo-router';
import { AuthProvider } from './lib/auth';
import { VideoStoreProvider } from './lib/videoStore';
import { ToastProvider } from './components/Toast';

export default function RootLayout() {
  return (
    <AuthProvider>
      <VideoStoreProvider>
        <ToastProvider>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="login" options={{ headerShown: false }} />
            <Stack.Screen name="signup" options={{ headerShown: false }} />
            <Stack.Screen name="upload" options={{ headerShown: false }} />
          </Stack>
        </ToastProvider>
      </VideoStoreProvider>
    </AuthProvider>
  );
}
