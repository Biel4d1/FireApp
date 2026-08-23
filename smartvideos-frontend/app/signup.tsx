import React, { useState } from 'react';
import { Button, KeyboardAvoidingView, Platform, StyleSheet, TextInput, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';

import { signup as apiSignup } from './lib/api';
import { useToast } from './components/Toast';

export default function SignupScreen() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const toast = useToast();

  async function handleSignup() {
    try {
      setLoading(true);
      const resp = await apiSignup(username, password);
      if (resp.status === 201) {
        toast.show('Account created. Please log in.');
        router.push('/login');
      } else {
        toast.show('Signup failed: ' + JSON.stringify(resp.data));
      }
    } catch (e: any) {
      const msg = e?.response?.data?.error || 'Signup error';
      toast.show('Signup failed: ' + msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.select({ ios: 'padding', android: undefined })} style={styles.container}>
      <Stack.Screen options={{ title: 'Sign Up' }} />
      <View style={styles.form}>
        <TextInput value={username} onChangeText={setUsername} placeholder="Username" style={styles.input} autoCapitalize="none" />
        <TextInput value={password} onChangeText={setPassword} placeholder="Password" secureTextEntry style={styles.input} />
        <Button title={loading ? 'Creating...' : 'Create account'} onPress={handleSignup} disabled={loading} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 16 },
  form: { gap: 12 },
  input: { borderWidth: 1, borderColor: '#ccc', padding: 12, borderRadius: 8 },
});
