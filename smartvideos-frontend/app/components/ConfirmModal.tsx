import React from 'react';
import { Modal, View, Text, StyleSheet, TouchableOpacity } from 'react-native';

export default function ConfirmModal({ visible, title, message, onConfirm, onCancel }: { visible: boolean; title?: string; message?: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          {title ? <Text style={styles.title}>{title}</Text> : null}
          {message ? <Text style={styles.message}>{message}</Text> : null}

          <View style={styles.actions}>
            <TouchableOpacity onPress={onCancel} style={[styles.btn, styles.ghostBtn]}>
              <Text style={styles.ghostText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onConfirm} style={[styles.btn, styles.primaryBtn]}>
              <Text style={styles.primaryText}>Yes</Text>
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
  message: { color: '#ddd', marginBottom: 18 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  btn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8 },
  primaryBtn: { backgroundColor: '#FF4500' },
  primaryText: { color: 'white', fontWeight: '700' },
  ghostBtn: { backgroundColor: 'rgba(255,255,255,0.06)' },
  ghostText: { color: '#bdbdbd', fontWeight: '700' },
});
