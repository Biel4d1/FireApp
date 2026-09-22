import { AuthContext } from "./auth";
import React, { useState, useContext } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  SafeAreaView,
  StatusBar,
} from 'react-native';

const API_BASE = 'https://api.smartvideos.lat';

export default function AuthScreen() {
  const { login } = useContext(AuthContext);
  const [activeTab, setActiveTab] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const handleAuth = async () => {
    if (!username.trim() || !password.trim()) {
      setErrorMsg('Please fill in both fields.');
      return;
    }

    setLoading(true);
    setErrorMsg('');

    const endpoint = activeTab === 'signup' ? '/signup' : '/login';

    try {
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();

      if (res.ok) {
        if (activeTab === 'signup') {
          await handleAutoLogin(username, password);
        } else if (data.token) {
          await login(data.token);
        }
      } else {
        setErrorMsg(data.error || 'Authentication failed. Please check credentials.');
      }
    } catch (e) {
      setErrorMsg('Cannot connect to authentication server.');
    } finally {
      setLoading(false);
    }
  };

  const handleAutoLogin = async (user, pass) => {
    try {
      const res = await fetch(`${API_BASE}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass }),
      });
      const data = await res.json();
      if (res.ok && data.token) {
        await login(data.token);
      } else {
        setErrorMsg('Account created, but automatic login failed. Please log in manually.');
        setActiveTab('login');
      }
    } catch (e) {
      setErrorMsg('Network error during auto-login.');
      setActiveTab('login');
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0b0c10" />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.innerContainer}
      >
        <View style={styles.brandContainer}>
          <Text style={styles.brandTitle}>goTunes</Text>
          <Text style={styles.brandSubtitle}>
            {activeTab === 'login' ? 'Welcome back! Log in to continue.' : 'Create an account to start listening.'}
          </Text>
        </View>

        <View style={styles.tabRow}>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'login' && styles.tabActive]}
            onPress={() => { setActiveTab('login'); setErrorMsg(''); }}
          >
            <Text style={[styles.tabText, activeTab === 'login' && styles.tabTextActive]}>Login</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'signup' && styles.tabActive]}
            onPress={() => { setActiveTab('signup'); setErrorMsg(''); }}
          >
            <Text style={[styles.tabText, activeTab === 'signup' && styles.tabTextActive]}>Sign Up</Text>
          </TouchableOpacity>
        </View>

        {errorMsg ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorCardText}>{errorMsg}</Text>
          </View>
        ) : null}

        <View style={styles.form}>
          <TextInput
            style={styles.input}
            placeholder="Username"
            placeholderTextColor="#666"
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
          />
          <TextInput
            style={styles.input}
            placeholder="Password"
            placeholderTextColor="#666"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />

          <TouchableOpacity
            style={styles.submitBtn}
            onPress={handleAuth}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#000" />
            ) : (
              <Text style={styles.submitBtnText}>
                {activeTab === 'login' ? 'Sign In' : 'Create Account'}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0c10' },
  innerContainer: { flex: 1, justifyContent: 'center', paddingHorizontal: 24 },
  brandContainer: { alignItems: 'center', marginBottom: 32 },
  brandTitle: { fontSize: 36, fontWeight: 'bold', color: '#00d2ff' },
  brandSubtitle: { fontSize: 14, color: '#8a8d9b', marginTop: 8, textAlign: 'center' },
  tabRow: { flexDirection: 'row', backgroundColor: '#15161e', borderRadius: 8, marginBottom: 20, padding: 4 },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center', borderRadius: 6 },
  tabActive: { backgroundColor: '#232533' },
  tabText: { color: '#8a8d9b', fontSize: 15, fontWeight: '600' },
  tabTextActive: { color: '#00d2ff' },
  errorCard: {
    backgroundColor: 'rgba(239, 68, 68, 0.18)',
    borderColor: 'rgba(239, 68, 68, 0.6)',
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginBottom: 16,
  },
  errorCardText: { color: '#ef4444', fontSize: 12, textAlign: 'center' },
  form: { width: '100%', gap: 12 },
  input: {
    backgroundColor: '#15161e',
    color: '#fff',
    borderRadius: 8,
    paddingHorizontal: 14,
    height: 48,
    borderWidth: 1,
    borderColor: '#232533',
    fontSize: 15,
  },
  submitBtn: {
    backgroundColor: '#00d2ff',
    height: 48,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
  submitBtnText: { color: '#000', fontSize: 15, fontWeight: 'bold' },
});
