import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, FlatList, ActivityIndicator, SafeAreaView, StatusBar, Alert } from 'react-native';
import { Audio } from 'expo-av';

const API_BASE = 'https://api.smartvideos.lat';

export default function GoTunesScreen({ token, setToken }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isSignup, setIsSignup] = useState(false);
  const [tracks, setTracks] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [sound, setSound] = useState(null);
  const [activeTrack, setActiveTrack] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const listenStartRef = useRef(0);
  const activeVideoIdRef = useRef(null);

  useEffect(() => {
    fetchRecommendations(0.5, 0.5);
    return () => { if (sound) sound.unloadAsync(); };
  }, []);

  const handleAuth = async () => {
    if (!username || !password) {
      Alert.alert('Error', 'Please enter both username and password.');
      return;
    }

    const endpoint = isSignup ? '/signup' : '/login';
    try {
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();

      if (res.ok) {
        if (isSignup) {
          Alert.alert('Success', 'Account created! Logging you in...');
          // Auto-login after signup
          setIsSignup(false);
          handleLoginDirect(username, password);
        } else if (data.token) {
          setToken(data.token);
          setPassword('');
        }
      } else {
        Alert.alert('Authentication Failed', data.error || 'Request failed.');
      }
    } catch (e) {
      Alert.alert('Network Error', 'Could not connect to authentication server.');
    }
  };

  const handleLoginDirect = async (user, pass) => {
    try {
      const res = await fetch(`${API_BASE}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass }),
      });
      const data = await res.json();
      if (res.ok && data.token) {
        setToken(data.token);
        setPassword('');
      }
    } catch (e) {
      console.warn('Auto-login error:', e);
    }
  };

  const fetchRecommendations = async (valence, intensity) => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/recommendations/by-audio?valence=${valence}&intensity=${intensity}`);
      const data = await res.json();
      setTracks(data.recommended_videos || []);
    } catch (e) { console.warn('Failed to load tracks', e); }
    finally { setLoading(false); }
  };

  const recordListenDuration = () => {
    const videoId = activeVideoIdRef.current;
    const startTime = listenStartRef.current;
    if (token && videoId && startTime > 0) {
      const listenMs = Date.now() - startTime;
      if (listenMs > 1000) {
        fetch(`${API_BASE}/api/gotunes/record-listen`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ video_id: videoId, listen_ms: listenMs })
        }).catch(err => console.warn('Listen logging failed:', err));
      }
    }
    listenStartRef.current = 0;
  };

  const playTrack = async (track) => {
    recordListenDuration();
    if (sound) await sound.unloadAsync();
    try {
      const { sound: newSound } = await Audio.Sound.createAsync(
        { uri: `${API_BASE}/${track.mp3_path}` },
        { shouldPlay: true }
      );
      setSound(newSound);
      setActiveTrack(track);
      setIsPlaying(true);
      activeVideoIdRef.current = track.id;
      listenStartRef.current = Date.now();

      newSound.setOnPlaybackStatusUpdate((status) => {
        if (status.didJustFinish) { setIsPlaying(false); recordListenDuration(); }
      });
    } catch (error) { console.error('Audio Playback Error:', error); }
  };

  const togglePlayPause = async () => {
    if (!sound) return;
    if (isPlaying) {
      await sound.pauseAsync();
      setIsPlaying(false);
      recordListenDuration();
    } else {
      await sound.playAsync();
      setIsPlaying(true);
      listenStartRef.current = Date.now();
    }
  };

  const filteredTracks = tracks.filter(t => {
    const q = searchQuery.toLowerCase();
    return (
      (t.description && t.description.toLowerCase().includes(q)) ||
      (t.filename && t.filename.toLowerCase().includes(q)) ||
      (t.tags && t.tags.toLowerCase().includes(q))
    );
  });

  return (
    <SafeAreaView style={styles.container}>
    <StatusBar barStyle="light-content" backgroundColor="#0b0c10" />
    <View style={styles.header}>
    <Text style={styles.title}>goTunes</Text>
    {!token ? (
      <View style={styles.authContainer}>
      <View style={styles.authRow}>
      <TextInput style={styles.inputSmall} placeholder="User" placeholderTextColor="#666" value={username} onChangeText={setUsername} autoCapitalize="none" />
      <TextInput style={styles.inputSmall} placeholder="Pass" placeholderTextColor="#666" secureTextEntry value={password} onChangeText={setPassword} />
      <TouchableOpacity style={styles.loginBtn} onPress={handleAuth}>
      <Text style={styles.btnTextDark}>{isSignup ? 'Sign Up' : 'Login'}</Text>
      </TouchableOpacity>
      </View>
      <TouchableOpacity onPress={() => setIsSignup(!isSignup)} style={{ marginTop: 4 }}>
      <Text style={styles.toggleText}>
      {isSignup ? 'Have an account? Login' : 'New user? Create account'}
      </Text>
      </TouchableOpacity>
      </View>
    ) : (
      <TouchableOpacity style={styles.logoutBtn} onPress={() => setToken(null)}>
      <Text style={styles.btnTextLight}>Logout</Text>
      </TouchableOpacity>
    )}
    </View>

    <View style={styles.searchContainer}>
    <TextInput style={styles.searchInput} placeholder="Search tracks or tags..." placeholderTextColor="#666" value={searchQuery} onChangeText={setSearchQuery} />
    </View>

    {loading ? (
      <ActivityIndicator size="large" color="#00d2ff" style={{ marginTop: 40 }} />
    ) : (
      <FlatList
      data={filteredTracks}
      keyExtractor={(item) => item.id.toString()}
      contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 120 }}
      renderItem={({ item }) => {
        const isActive = activeTrack?.id === item.id;
        return (
          <TouchableOpacity style={[styles.card, isActive && styles.cardActive]} onPress={() => playTrack(item)}>
          <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle}>{item.description || item.filename}</Text>
          <Text style={styles.cardMeta}>Valence: {item.valence.toFixed(2)} | Energy: {item.intensity.toFixed(2)}</Text>
          {item.tags ? <Text style={styles.cardTags}>🏷 {item.tags}</Text> : null}
          </View>
          <Text style={[styles.playIndicator, isActive && { color: '#00d2ff' }]}>{isActive && isPlaying ? '⏸' : '▶'}</Text>
          </TouchableOpacity>
        );
      }}
      />
    )}

    {activeTrack && (
      <View style={styles.playerBar}>
      <View style={{ flex: 1 }}>
      <Text style={styles.playerTitle} numberOfLines={1}>{activeTrack.description || activeTrack.filename}</Text>
      <Text style={styles.playerSub}>Track #{activeTrack.id}</Text>
      </View>
      <TouchableOpacity style={styles.controlBtn} onPress={togglePlayPause}>
      <Text style={styles.controlBtnText}>{isPlaying ? 'Pause' : 'Play'}</Text>
      </TouchableOpacity>
      </View>
    )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0c10' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderColor: '#1f212d' },
  title: { fontSize: 22, fontWeight: 'bold', color: '#00d2ff' },
  authContainer: { alignItems: 'flex-end' },
  authRow: { flexDirection: 'row', gap: 6 },
  inputSmall: { backgroundColor: '#15161e', color: '#fff', fontSize: 12, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, width: 65, borderWidth: 1, borderColor: '#27272a' },
  loginBtn: { backgroundColor: '#00d2ff', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, justifyContent: 'center' },
  logoutBtn: { backgroundColor: '#ef4444', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, justifyContent: 'center' },
  btnTextDark: { color: '#000', fontWeight: 'bold', fontSize: 11 },
  btnTextLight: { color: '#fff', fontWeight: 'bold', fontSize: 11 },
  toggleText: { color: '#00d2ff', fontSize: 10, textDecorationLine: 'underline' },
  searchContainer: { padding: 16 },
  searchInput: { backgroundColor: '#15161e', color: '#fff', borderRadius: 10, padding: 12, borderWidth: 1, borderColor: '#232533' },
  card: { backgroundColor: '#15161e', padding: 14, borderRadius: 12, marginBottom: 10, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#232533' },
  cardActive: { borderColor: '#00d2ff', backgroundColor: '#181b26' },
  cardTitle: { color: '#f3f4f6', fontSize: 15, fontWeight: '600' },
  cardMeta: { color: '#8a8d9b', fontSize: 12, marginTop: 4 },
  cardTags: { color: '#00d2ff', fontSize: 11, marginTop: 4 },
  playIndicator: { fontSize: 16, fontWeight: 'bold', color: '#8a8d9b', marginLeft: 10 },
  playerBar: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#15161e', borderTopWidth: 1, borderColor: '#232533', padding: 16, flexDirection: 'row', alignItems: 'center' },
  playerTitle: { color: '#fff', fontWeight: 'bold', fontSize: 14 },
  playerSub: { color: '#8a8d9b', fontSize: 12 },
  controlBtn: { backgroundColor: '#00d2ff', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
  controlBtnText: { color: '#000', fontWeight: 'bold', fontSize: 12 }
});
