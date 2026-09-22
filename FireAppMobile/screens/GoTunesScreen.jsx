import { AuthContext } from "../lib/auth";
import React, { useContext, useState, useEffect, useRef } from "react";
import { StyleSheet, Text, View, TextInput, TouchableOpacity, FlatList, ActivityIndicator, SafeAreaView, StatusBar } from "react-native";
import { Audio } from "expo-av";

const API_BASE = "https://api.smartvideos.lat";

export default function GoTunesScreen() {
  const { logout, token, user } = useContext(AuthContext);
  const [tracks, setTracks] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [sound, setSound] = useState(null);
  const [activeTrack, setActiveTrack] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const listenStartRef = useRef(0);
  const activeVideoIdRef = useRef(null);

  const getTrackTitle = (track) => {
    if (!track) return "";
    if (track.song_title && track.song_title.trim() !== "") {
      return track.song_artist ? `${track.song_title} - ${track.song_artist}` : track.song_title;
    }
    const uploader = track.username && track.username !== "Unknown" ? track.username : (track.uploader_name || "User");
    return `Original Sound - ${uploader}`;
  };

  useEffect(() => {
    const setupAudioSession = async () => {
      try {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          staysActiveInBackground: true,
          playsInSilentModeIOS: true,
          shouldDuckAndroid: true,
          playThroughEarpieceAndroid: false,
        });
      } catch (e) {
        console.warn("Failed to configure audio session:", e);
      }
    };

    setupAudioSession();
    fetchRecommendations(0.5, 0.5);

    return () => {
      if (sound) sound.unloadAsync();
    };
  }, []);

  const fetchRecommendations = async (valence, intensity) => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/recommendations/by-audio?valence=${valence}&intensity=${intensity}`);
      const data = await res.json();
      setTracks(data.recommended_videos || []);
    } catch (e) { console.warn("Failed to load tracks", e); }
    finally { setLoading(false); }
  };

  const recordListenDuration = () => {
    const videoId = activeVideoIdRef.current;
    const startTime = listenStartRef.current;
    if (token && videoId && startTime > 0) {
      const listenMs = Date.now() - startTime;
      if (listenMs > 1000) {
        fetch(`${API_BASE}/api/gotunes/record-listen`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ video_id: videoId, listen_ms: listenMs })
        }).catch(err => console.warn("Listen logging failed:", err));
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
    } catch (error) { console.error("Audio Playback Error:", error); }
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
      (t.tags && t.tags.toLowerCase().includes(q)) ||
      (t.song_title && t.song_title.toLowerCase().includes(q)) ||
      (t.song_artist && t.song_artist.toLowerCase().includes(q))
    );
  });

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0b0c10" />
      <View style={styles.header}>
        <Text style={styles.title}>goTunes</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {user?.username ? <Text style={{ color: "#8a8d9b", fontSize: 13, fontWeight: "600" }}>@{user.username}</Text> : null}
          <TouchableOpacity style={styles.logoutBtn} onPress={logout}>
            <Text style={styles.btnTextLight}>Logout</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.searchContainer}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search tracks or tags..."
          placeholderTextColor="#666"
          value={searchQuery}
          onChangeText={setSearchQuery}
        />
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
                  <Text style={styles.cardTitle}>{getTrackTitle(item)}</Text>
                  <Text style={styles.cardMeta}>Valence: {item.valence ? item.valence.toFixed(2) : "0.00"} | Energy: {item.intensity ? item.intensity.toFixed(2) : "0.00"}</Text>
                  {item.tags ? <Text style={styles.cardTags}>🏷 {item.tags}</Text> : null}
                </View>
                <Text style={[styles.playIndicator, isActive && { color: "#00d2ff" }]}>{isActive && isPlaying ? "⏸" : "▶"}</Text>
              </TouchableOpacity>
            );
          }}
        />
      )}

      {activeTrack && (
        <View style={styles.playerBar}>
          <View style={{ flex: 1 }}>
            <Text style={styles.playerTitle} numberOfLines={1}>{getTrackTitle(activeTrack)}</Text>
            <Text style={styles.playerSub}>Track #{activeTrack.id}</Text>
          </View>
          <TouchableOpacity style={styles.controlBtn} onPress={togglePlayPause}>
            <Text style={styles.controlBtnText}>{isPlaying ? "Pause" : "Play"}</Text>
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b0c10" },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16, borderBottomWidth: 1, borderColor: "#1f212d" },
  title: { fontSize: 22, fontWeight: "bold", color: "#00d2ff" },
  logoutBtn: { backgroundColor: "#ef4444", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, justifyContent: "center" },
  btnTextLight: { color: "#fff", fontWeight: "bold", fontSize: 12 },
  searchContainer: { padding: 16 },
  searchInput: { backgroundColor: "#15161e", color: "#fff", borderRadius: 10, padding: 12, borderWidth: 1, borderColor: "#232533" },
  card: { backgroundColor: "#15161e", padding: 14, borderRadius: 12, marginBottom: 10, flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: "#232533" },
  cardActive: { borderColor: "#00d2ff", backgroundColor: "#181b26" },
  cardTitle: { color: "#f3f4f6", fontSize: 15, fontWeight: "600" },
  cardMeta: { color: "#8a8d9b", fontSize: 12, marginTop: 4 },
  cardTags: { color: "#00d2ff", fontSize: 11, marginTop: 4 },
  playIndicator: { fontSize: 16, fontWeight: "bold", color: "#8a8d9b", marginLeft: 10 },
  playerBar: { position: "absolute", bottom: 0, left: 0, right: 0, backgroundColor: "#15161e", borderTopWidth: 1, borderColor: "#232533", padding: 16, flexDirection: "row", alignItems: "center" },
  playerTitle: { color: "#fff", fontWeight: "bold", fontSize: 14 },
  playerSub: { color: "#8a8d9b", fontSize: 12 },
  controlBtn: { backgroundColor: "#00d2ff", paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
  controlBtnText: { color: "#000", fontWeight: "bold", fontSize: 12 }
});
