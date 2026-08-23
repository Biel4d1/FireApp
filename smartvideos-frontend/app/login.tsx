import React, { useContext, useEffect, useState } from 'react';
import {
  Button,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  ToastAndroid,
  TouchableOpacity,
  View,
  BackHandler,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { login as apiLogin, signup as apiSignup } from './lib/api';
import { AuthContext } from './lib/auth';
import { useToast } from './components/Toast';

export default function LoginScreen() {
  const [active, setActive] = useState<'login' | 'signup'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const { signIn } = useContext(AuthContext);
  const router = useRouter();
  const toast = useToast();

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const onBackPress = () => {
      try { BackHandler.exitApp(); } catch (e) {}
      return true; // indicate we've handled the back press
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => { try { sub.remove(); } catch (e) {} };
  }, []);

  async function handleLogin() {
    setLoading(true);
    try {
      try { toast.show('API URL: ' + (process.env.EXPO_PUBLIC_API_URL || 'NOT SET')); } catch (e) {}
      const loginResp = await apiLogin(username, password);
      try { console.log('login response', loginResp?.status, loginResp?.data); } catch (e) {}

      const token = loginResp.data?.token;
      if (token) {
        await signIn(token);
        try { toast.show('Welcome to FireApp!'); } catch (e) {}
        router.replace('/(tabs)');
      } else {
        const errorMsg = loginResp.data?.error;
        const msg = errorMsg || 'No token returned';
        try { toast.show(msg); } catch (e) {}
        try { console.error('login missing token', loginResp); } catch (e) {}
      }
    } catch (err: any) {
      try { console.error('login error full:', JSON.stringify(err, null, 2)); } catch (e) {}
      try { console.error('login error message:', err?.message); } catch (e) {}
      try { console.error('login error response:', err?.response); } catch (e) {}
      const msg = err?.response?.data?.error || err?.message || 'Connection error - cannot reach API';
      try { toast.show(msg); } catch (e) {}
    } finally {
      setLoading(false);
    }
  }

  async function handleSignup() {
    try {
      setLoading(true);
      const signupResp = await apiSignup(username, password);
      try { console.log('signup response', signupResp?.status, signupResp?.data); } catch (e) {}
      if (signupResp.status === 201) {
        // automatically log in after signup
        const loginResp = await apiLogin(username, password);
        try { console.log('post-signup login response', loginResp?.status, loginResp?.data); } catch (e) {}
        const token = loginResp.data?.token;
        if (token) {
          await signIn(token);
          try { toast.show('Welcome to FireApp!'); } catch (e) {}
          router.replace('/(tabs)');
        } else {
          const msg = 'Signup succeeded but login returned no token';
          try { console.error('signup no token', loginResp); } catch (e) {}
          try { toast.show(msg); } catch (e) {}
        }
      } else {
        const msg = JSON.stringify(signupResp.data || signupResp);
        try { toast.show(msg); } catch (e) {}
      }
    } catch (err: any) {
      try { console.error('signup error', err); } catch (e) {}
      const msg = err?.response?.data?.error || 'Signup error';
      try { toast.show(msg); } catch (e) {}
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView behavior={Platform.select({ ios: 'padding', android: undefined })} style={styles.container}>
        <View style={styles.brand}>
          <Ionicons name="flame" size={80} color="#ff5a00" />
          <Text style={styles.brandText}>FireApp</Text>
        </View>

        <View style={styles.tabRow}>
          <TouchableOpacity style={[styles.tab, active === 'login' && styles.tabActive]} onPress={() => setActive('login')}>
            <Text style={[styles.tabText, active === 'login' && styles.tabTextActive]}>Login</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.tab, active === 'signup' && styles.tabActive]} onPress={() => setActive('signup')}>
            <Text style={[styles.tabText, active === 'signup' && styles.tabTextActive]}>Sign Up</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.form}>
          <TextInput
            value={username}
            onChangeText={setUsername}
            placeholder="Username"
            placeholderTextColor="#bbb"
            style={styles.input}
            autoCapitalize="none"
          />
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            placeholderTextColor="#bbb"
            secureTextEntry
            style={styles.input}
          />

          {active === 'login' ? (
            <Button title={loading ? 'Signing in...' : 'Sign in'} onPress={handleLogin} disabled={loading} />
          ) : (
            <Button title={loading ? 'Creating...' : 'Create account'} onPress={handleSignup} disabled={loading} />
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#000' },
  container: { flex: 1, padding: 20, alignItems: 'center' },
  brand: { alignItems: 'center', marginTop: 24, marginBottom: 12 },
  brandText: { color: 'white', fontSize: 36, fontWeight: '900', marginTop: 8 },
  tabRow: { flexDirection: 'row', width: '100%', marginTop: 16, marginBottom: 16, backgroundColor: '#111', borderRadius: 8 },
  tab: { flex: 1, padding: 12, alignItems: 'center' },
  tabActive: { backgroundColor: '#222', borderRadius: 8 },
  tabText: { color: '#888', fontSize: 16 },
  tabTextActive: { color: 'white', fontWeight: '700' },
  form: { width: '100%', marginTop: 12, gap: 12 },
  input: { backgroundColor: '#333', color: 'white', padding: 12, borderRadius: 8 },
});

// Duplicate styles removed. The primary `styles` object above is used.
