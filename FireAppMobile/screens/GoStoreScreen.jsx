import React from 'react';
import { StyleSheet, Text, View, TouchableOpacity, Linking, SafeAreaView } from 'react-native';

const API_BASE = 'https://api.smartvideos.lat';

export default function GoStoreScreen() {
  const downloadApp = (endpoint) => { Linking.openURL(`${API_BASE}/download/${endpoint}`); };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>goStore Hub</Text>
        <Text style={styles.subtitle}>Official Android APK Distribution</Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.appTitle}>FireApp Mobile</Text>
        <Text style={styles.badge}>Android APK</Text>
        <Text style={styles.desc}>Multimodal video streaming platform featuring tag matching and real-time feed personalization.</Text>
        <TouchableOpacity style={styles.btnOrange} onPress={() => downloadApp('fireapp')}>
          <Text style={styles.btnTextLight}>Download FireApp APK</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.card}>
        <Text style={styles.appTitle}>goTunes Player</Text>
        <Text style={styles.badgeBlue}>Android APK</Text>
        <Text style={styles.desc}>Standalone audio player for extracted video audio, streaming directly from your server with active interaction logging.</Text>
        <TouchableOpacity style={styles.btnBlue} onPress={() => downloadApp('gotunes')}>
          <Text style={styles.btnTextDark}>Download goTunes APK</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0c', padding: 20 },
  header: { marginBottom: 24, marginTop: 10 },
  title: { fontSize: 28, fontWeight: '800', color: '#ff4500' },
  subtitle: { fontSize: 13, color: '#9ca3af', marginTop: 4 },
  card: { backgroundColor: '#141417', borderWidth: 1, borderColor: '#27272a', borderRadius: 14, padding: 20, marginBottom: 16 },
  appTitle: { fontSize: 18, fontWeight: 'bold', color: '#fff' },
  badge: { color: '#ff8c00', fontSize: 11, fontWeight: 'bold', marginTop: 4, marginBottom: 8 },
  badgeBlue: { color: '#00d2ff', fontSize: 11, fontWeight: 'bold', marginTop: 4, marginBottom: 8 },
  desc: { color: '#a1a1aa', fontSize: 13, lineHeight: 18, marginBottom: 16 },
  btnOrange: { backgroundColor: '#ff4500', padding: 12, borderRadius: 8, alignItems: 'center' },
  btnBlue: { backgroundColor: '#00d2ff', padding: 12, borderRadius: 8, alignItems: 'center' },
  btnTextLight: { color: '#fff', fontWeight: 'bold' },
  btnTextDark: { color: '#000', fontWeight: 'bold' }
});
