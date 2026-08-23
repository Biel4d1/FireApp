import React, { createContext, useCallback, useContext, useState, useEffect } from 'react';
import { Animated, StyleSheet, Text, View, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

type ToastItem = { id: number; text: string; duration?: number };

const ToastContext = createContext<{ show: (text: string, opts?: { duration?: number }) => void } | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const show = useCallback((text: string, opts?: { duration?: number }) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    const t: ToastItem = { id, text, duration: opts?.duration ?? 2500 };
    setToasts(s => [...s, t]);
    setTimeout(() => setToasts(s => s.filter(x => x.id !== id)), t.duration + 50);
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <ToastContainer toasts={toasts} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

function ToastContainer({ toasts }: { toasts: ToastItem[] }) {
  return (
    <View pointerEvents="box-none" style={styles.container}>
      {toasts.map(t => <Toast key={String(t.id)} text={t.text} />)}
    </View>
  );
}

function Toast({ text }: { text: string }) {
  const anim = React.useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.sequence([
      Animated.timing(anim, { toValue: 1, duration: 220, useNativeDriver: true }),
      Animated.delay(2200),
      Animated.timing(anim, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start();
  }, [anim, text]);

  return (
    <Animated.View style={[styles.toast, { transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) }], opacity: anim }]}> 
      <Ionicons name="flame" size={18} color="#fff" style={{ marginRight: 8 }} />
      <Text style={styles.text}>{text}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: { position: 'absolute', left: 0, right: 0, bottom: 36, alignItems: 'center', zIndex: 1000, pointerEvents: 'box-none' },
  toast: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.8)', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, marginTop: 8, maxWidth: '92%' },
  text: { color: 'white', fontWeight: '700' },
});

export default ToastProvider;
