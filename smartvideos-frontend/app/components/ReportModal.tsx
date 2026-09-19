import React, { useState } from 'react';
import { Modal, View, Text, StyleSheet, TouchableOpacity, TextInput } from 'react-native';

export default function ReportModal({ visible, initialText, onCancel, onSubmit, title, message }: { visible: boolean; initialText?: string; onCancel: () => void; onSubmit: (text: string) => void; title?: string; message?: string }) {
  const [text, setText] = useState(initialText || '');

  React.useEffect(() => {
    setText(initialText || '');
  }, [initialText, visible]);

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>{title || 'Report video'}</Text>
          <Text style={styles.message}>{message || "Please describe the issue (optional):"}</Text>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Describe why you're reporting this video"
            placeholderTextColor="#666"
            multiline
            numberOfLines={4}
            style={styles.input}
          />

          <View style={styles.actions}>
            <TouchableOpacity onPress={() => { setText(''); onCancel(); }} style={[styles.btn, styles.ghostBtn]}>
              <Text style={styles.ghostText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { onSubmit(text.trim()); setText(''); }} style={[styles.btn, styles.primaryBtn]}>
              <Text style={styles.primaryText}>Report</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
  sheet: { width: '86%', backgroundColor: '#0b0b0b', borderRadius: 12, padding: 18 },
  title: { color: 'white', fontSize: 18, fontWeight: '700', marginBottom: 6 },
  message: { color: '#ddd', marginBottom: 12 },
  input: { backgroundColor: '#111', color: 'white', padding: 10, borderRadius: 8, minHeight: 80, textAlignVertical: 'top' as any, marginBottom: 12 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  btn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8 },
  primaryBtn: { backgroundColor: '#FF4500' },
  primaryText: { color: 'white', fontWeight: '700' },
  ghostBtn: { backgroundColor: 'rgba(255,255,255,0.06)' },
  ghostText: { color: '#bdbdbd', fontWeight: '700' },
});
