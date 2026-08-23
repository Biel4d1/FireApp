import React, { useContext, useEffect, useState, useRef } from 'react';
import { ActivityIndicator, FlatList, Image, Platform, Pressable, StyleSheet, Text, TouchableOpacity, View, Modal, TextInput } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
// @ts-ignore: skip missing type declarations for expo-image-picker in this environment
import * as ImagePicker from 'expo-image-picker';
import { Stack, useLocalSearchParams } from 'expo-router';
import { AuthContext } from './lib/auth';
import { useToast } from './components/Toast';
import { useVideoStore } from './lib/videoStore';
import { useRouter } from 'expo-router';
import { registerPlayer as globalRegisterPlayer } from './lib/playerRegistry';
import GradientText from './components/GradientText';
import ConfirmModal from './components/ConfirmModal';
import LoadingOverlay from './components/LoadingOverlay';
import { getApiClient, getToken, deleteAccount, reportUser } from './lib/api';
import ReportModal from './components/ReportModal';
import VideoPlayer from './components/VideoPlayer';
import { Video } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';

export default function ProfileScreen() {
  const { signOut, user, setUser, refreshUser } = useContext(AuthContext);
  const params = useLocalSearchParams() as any;
  const viewingUserParam = params?.user_id ?? null;
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [videos, setVideos] = useState<any[]>([]);
  const videoStore = useVideoStore();
  const toast = useToast();
  const [showSignOutModal, setShowSignOutModal] = useState(false);
  const [showDeleteAccountModal, setShowDeleteAccountModal] = useState(false);
  const [showDeletePasswordModal, setShowDeletePasswordModal] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [reportVisible, setReportVisible] = useState(false);
  const [reportInitialText, setReportInitialText] = useState<string | undefined>(undefined);
  const isOwnerView = (!viewingUserParam || (user && String(user.id) === String(viewingUserParam)));

  async function fetchProfileAndVideos() {
    setLoading(true);
    try {
      const client = getApiClient();
      // Try to fetch current user (may be unauthenticated)
      let me: any = null;
      try {
        const meResp = await client.get('/me');
        me = meResp.data?.user ?? null;
      } catch (e) {
        me = null;
      }
      setUser(me);

      // Determine which user's profile to load
      const targetUserId = viewingUserParam ? Number(viewingUserParam) : me?.id;
      const vidsResp = viewingUserParam ? await client.get('/videos', { params: { user_id: targetUserId } }) : await client.get('/videos');
      const all = vidsResp?.data?.videos || [];
      try { videoStore.setVideos(all); } catch (e) {}

      const profileUserIdStr = String(targetUserId ?? '');
      const myVideos = all.filter((v: any) => String(v.uploader_id) === profileUserIdStr).map((v: any) => {
        try {
          const g = videoStore.getVideo(v.id);
          if (g && typeof g.likes_count === 'number') return { ...v, likes_count: g.likes_count };
        } catch (e) {}
        return v;
      });
      setVideos(myVideos);
    } catch (e) {
      // ignore errors; keep UI stable
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchProfileAndVideos();
  }, [viewingUserParam]);

  async function pickImageAndUpload() {
    const res = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (res.status !== 'granted') return;
    const picker = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.8, allowsEditing: true });
    // expo-image-picker uses the American spelling 'canceled'
    if ((picker as any).canceled || (picker as any).cancelled) return;
    const uri = picker.assets?.[0]?.uri ?? (picker as any).uri;
    if (!uri) return;
    // normalize android uri
    let uploadUri = uri;
    if (Platform.OS === 'android' && !uploadUri.startsWith('file://')) uploadUri = 'file://' + uploadUri;

    // derive file extension and mime type
    const extMatch = uploadUri.match(/\.([^.\/?]+)(?:\?|$)/);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
    const filename = `profile_${Date.now()}.${ext}`;

    const form = new FormData();
    // append file with correct fields expected by Flask
    // @ts-ignore
    form.append('file', { uri: uploadUri, name: filename, type: mime });

      try {
        setLoading(true);
        console.log('[PFP Upload] Starting upload (XHR)...');

        const client = getApiClient();
        const base = (client.defaults.baseURL || '').replace(/\/$/, '') || ((getApiClient() as any).API_BASE_URL || '');
        const url = `${base}/upload_profile_pic`;

        const token = await getToken();

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', url);
          xhr.timeout = 60 * 1000;
          if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

          xhr.onload = () => {
            try {
              const status = xhr.status;
              const txt = xhr.responseText || '';
              let data: any = {};
              try { data = txt ? JSON.parse(txt) : {}; } catch (e) { data = { raw: txt }; }
              if (status === 200 || status === 201) {
                if (!data?.profile_pic_url) return reject(new Error('No profile_pic_url in response'));
                // update local user and resolve
                setUser((u: any) => ({ ...u, profile_pic_url: data.profile_pic_url }));
                try { refreshUser().catch(() => {}); } catch (e) {}
                resolve();
              } else {
                const msg = data?.error || data?.message || txt || `HTTP ${status}`;
                reject(new Error(msg));
              }
            } catch (e) { reject(e as any); }
          };

          xhr.onerror = () => reject(new Error('Network Error'));
          xhr.ontimeout = () => reject(new Error('Upload timed out'));

          try {
            xhr.send(form as any);
          } catch (err) {
            reject(err as any);
          }
        });

        try { toast.show('Profile picture updated!'); } catch (e) {}
      } catch (e: any) {
        console.error('[PFP Upload] Error:', e?.message || e);
        try { toast.show('Upload failed: ' + (e?.message || 'Unknown error')); } catch (e2) {}
      } finally {
        setLoading(false);
      }
  }

  async function removePhoto() {
    try {
      setLoading(true);
      console.log('[Remove PFP] Removing profile picture...');
      await getApiClient().post('/remove_profile_pic');
      console.log('[Remove PFP] Success');
      setUser((u: any) => ({ ...u, profile_pic_url: null }));
    } catch (e: any) {
      console.error('[Remove PFP] Error:', e.response?.data || e.message);
      try { toast.show('Remove failed: ' + (e?.response?.data?.error || e.message || 'Unknown error')); } catch (e2) {}
    } finally {
      setLoading(false);
    }
  }
  function renderGridItem({ item }: { item: any }) {
    const base = (getApiClient().defaults.baseURL || '').replace(/\/$/, '');
    const uri = `${base}/video/${item.filename}`;
    const isLiked = item.liked || item.is_liked || false;

    return (
      <GridVideoItem
        item={item}
        uri={uri}
        isLiked={isLiked}
        onNavigate={(isPlaying?: boolean) => router.push({ pathname: '/video/[id]', params: { id: String(item.id), profile_pic_url: item?.profile_pic_url, username: item?.username, uploader_id: item?.uploader_id, initialPlaying: isPlaying ? '1' : '0' } })}
      />
    );
  }

  function GridVideoItem({ item, uri, isLiked, onNavigate }: { item: any; uri: string; isLiked: boolean; onNavigate: (isPlaying?: boolean) => void }) {
    const videoRef = useRef<any>(null);

    useEffect(() => {
      try { globalRegisterPlayer(item.id, videoRef); } catch (e) {}
      return () => { try { globalRegisterPlayer(item.id, undefined); } catch (e) {} };
    }, [item.id]);

    const [isPlaying, setIsPlaying] = useState(false);

    const handleTogglePlay = async () => {
      try {
        const p = videoRef.current as any;
        if (!p) return;
        const status = typeof p.getStatusAsync === 'function' ? await p.getStatusAsync().catch(() => null) : null;
        if (status && status.isPlaying) {
          if (typeof p.pauseAsync === 'function') await p.pauseAsync();
          try { setIsPlaying(false); } catch (e) {}
        } else {
          if (typeof p.playAsync === 'function') await p.playAsync();
          try { setIsPlaying(true); } catch (e) {}
        }
      } catch (e) {}
    };

    return (
      <View style={styles.gridItem}>
        <Pressable onPress={() => onNavigate(isPlaying)} onLongPress={handleTogglePlay} style={{ flex: 1 }}>
          <VideoPlayer id={item.id} playerRef={videoRef} source={{ uri }} style={styles.gridVideo} shouldPlay={false} />

          <View style={styles.gridOverlay}>
            <View style={styles.gridLikeContainer}>
              <Ionicons name="heart" size={20} color={isLiked ? '#ff1744' : 'rgba(255,255,255,0.7)'} />
              <Text style={styles.gridLikeCount}>{item.likes_count || 0}</Text>
            </View>
          </View>
        </Pressable>
      </View>
    );
  }

      

  

  const totalLikes = videos.reduce((sum, v) => sum + (Number(v?.likes_count) || 0), 0);

  // Determine section title: show "My Videos" for owner, otherwise "{username}'s videos"
  const profileOwnerUsername = (videos?.[0]?.username) || user?.username || '';
  const sectionTitle = isOwnerView ? 'My Videos' : `${profileOwnerUsername}'s videos`;

  return (
    <SafeAreaView style={styles.container}>
      <Stack.Screen options={{ title: 'Profile' }} />
      <View style={styles.header}>
        {viewingUserParam && user && String(user.id) !== String(viewingUserParam) ? (
          <TouchableOpacity onPress={() => { setReportInitialText(undefined); setReportVisible(true); }} style={{ position: 'absolute', right: 16, top: 16 }}>
            <Ionicons name="flag" size={22} color="white" />
          </TouchableOpacity>
        ) : null}
        {loading ? (
          <ActivityIndicator />
        ) : (
          <View style={{ alignItems: 'center' }}>
            {(() => {
              const displayedProfilePic = (() => {
                const first = videos?.[0];
                // If viewing own profile, prefer authenticated user's profile picture.
                if (isOwnerView) {
                  return user?.profile_pic_url ?? (first && first.profile_pic_url) ?? null;
                }
                // Read-only view of another user: prefer that user's video metadata (if available).
                return (first && first.profile_pic_url) ?? null;
              })();
              if (displayedProfilePic) {
                const base = (getApiClient().defaults.baseURL || '').replace(/\/$/, '');
                const raw = displayedProfilePic;
                const absolute = String(raw).startsWith('http');
                const url = absolute ? raw : `${base}/${raw}`;
                return (
                  <ExpoImage 
                    source={{ uri: url }} 
                    style={styles.largePfp} 
                    contentFit="cover"
                    cachePolicy="disk"
                    onError={() => {
                      console.warn('[PFP] Failed to load profile image:', url);
                      setUser((u: any) => ({ ...u, profile_pic_url: null }));
                    }}
                  />
                );
              }
              return (
                <View style={[styles.largePfp, styles.pfpPlaceholder]}>
                  <Ionicons name="flame" size={48} color="white" />
                </View>
              );
            })()}

            <Text style={styles.username}>@{isOwnerView ? (user?.username || (videos?.[0]?.username)) : (videos?.[0]?.username || user?.username)}</Text>

            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, marginBottom: 12, gap: 6 }}>
              <Ionicons name="flame" size={24} color="#FF6B35" />
              <Text style={{ color: 'white', fontWeight: '700', fontSize: 16 }}>
                {totalLikes}
              </Text>
            </View>

            <View style={{ height: 12 }} />
            {isOwnerView ? (
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <TouchableOpacity onPress={pickImageAndUpload} style={styles.button}>
                  <Text style={styles.buttonText}>Change Photo</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={removePhoto} style={[styles.button, { backgroundColor: '#666' }] }>
                  <Text style={styles.buttonText}>Remove Photo</Text>
                </TouchableOpacity>
              </View>
            ) : (
              null
            )}
          </View>
        )}
      </View>

      <View style={styles.gallery}>
        <Text style={styles.sectionTitle}>{sectionTitle}</Text>
        {loading ? (
          <ActivityIndicator />
        ) : (
          <FlatList data={videos} numColumns={3} keyExtractor={v => String(v.id)} renderItem={renderGridItem} />
        )}
      </View>

      {isOwnerView ? (
        <View style={{ padding: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
          <TouchableOpacity onPress={() => setShowSignOutModal(true)} style={[styles.button, { backgroundColor: '#ff3b30', flex: 1, marginRight: 8 }] }>
            <Text style={styles.buttonText}>Sign out</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={() => setShowDeleteAccountModal(true)} style={[styles.button, { backgroundColor: '#8b0000', flex: 1, marginLeft: 8 }] }>
            <Text style={styles.buttonText}>Delete account</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <ConfirmModal visible={showSignOutModal} title="Sign out" message="Are you sure you want to sign out?" onCancel={() => setShowSignOutModal(false)} onConfirm={async () => {
        setShowSignOutModal(false);
        try { console.log('Sign out requested'); await AsyncStorage.clear(); } catch (e) { console.error('AsyncStorage.clear error', e); }
        try { await signOut(); console.log('signOut() completed'); } catch (e) { console.error('signOut error', e); }
        // Force navigate to login by replacing the entire stack - this prevents navigation loops
        try { router.replace('/login'); } catch (e) { console.error('Navigation error:', e); }
      }} />
      {reportVisible && (
        <ReportModal visible={reportVisible} initialText={reportInitialText} title="Report user" message="Please describe the issue (optional):" onCancel={() => setReportVisible(false)} onSubmit={async (text) => {
          try {
            setReportVisible(false);
            const targetUserId = viewingUserParam ? Number(viewingUserParam) : null;
            if (!targetUserId) return;
            await reportUser(targetUserId, text || 'Reported user');
            try { toast.show('User reported'); } catch (e) {}
          } catch (e: any) {
            try { toast.show(e?.response?.data?.error || 'Report failed'); } catch (e) {}
          }
        }} />
      )}
      <LoadingOverlay visible={loading} />
        <ConfirmModal visible={showDeleteAccountModal} title="Delete account" message="This will permanently delete your account. Continue?" onCancel={() => setShowDeleteAccountModal(false)} onConfirm={() => {
          setShowDeleteAccountModal(false);
          setShowDeletePasswordModal(true);
        }} />

        <Modal visible={showDeletePasswordModal} transparent animationType="fade">
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ width: '86%', backgroundColor: '#0b0b0b', borderRadius: 12, padding: 18 }}>
              <Text style={{ color: 'white', fontSize: 18, fontWeight: '700', marginBottom: 8 }}>Confirm password</Text>
              <Text style={{ color: '#ddd', marginBottom: 12 }}>Enter your password to permanently delete your account.</Text>
              <TextInput value={deletePassword} onChangeText={setDeletePassword} secureTextEntry placeholder="Password" placeholderTextColor="#666" style={{ backgroundColor: '#111', color: 'white', padding: 10, borderRadius: 8, marginBottom: 12 }} />
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 12 }}>
                <TouchableOpacity onPress={() => { setShowDeletePasswordModal(false); setDeletePassword(''); }} style={{ paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.06)' }}>
                  <Text style={{ color: '#bdbdbd', fontWeight: '700' }}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={async () => {
                  try {
                    setShowDeletePasswordModal(false);
                    setLoading(true);
                    await deleteAccount(deletePassword);
                    try { await AsyncStorage.clear(); } catch (e) {}
                    try { await signOut(); } catch (e) {}
                    try { router.replace('/login'); } catch (e) {}
                  } catch (e: any) {
                    try { toast.show(e?.response?.data?.error || e?.message || 'Delete failed'); } catch (e) {}
                  } finally {
                    setDeletePassword('');
                    setLoading(false);
                  }
                }} style={{ paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, backgroundColor: '#8b0000' }}>
                  <Text style={{ color: 'white', fontWeight: '700' }}>Delete</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  header: { padding: 18, alignItems: 'center' },
  largePfp: { width: 120, height: 120, borderRadius: 60 },
  pfpPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#222' },
  username: { color: 'white', marginTop: 8, fontWeight: '700' },
  button: { paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#1e90ff', borderRadius: 8, alignItems: 'center' },
  buttonText: { color: 'white', fontWeight: '700' },
  gallery: { flex: 1, paddingHorizontal: 8 },
  sectionTitle: { color: 'white', fontWeight: '700', marginBottom: 8 },
  gridItem: { flex: 1 / 3, aspectRatio: 1, padding: 4 },
  gridVideo: { width: '100%', height: '100%', borderRadius: 8, overflow: 'hidden' },
  gridOverlay: { 
    position: 'absolute', 
    top: 0, 
    left: 0, 
    right: 0, 
    bottom: 0, 
    padding: 6,
    justifyContent: 'flex-end',
    alignItems: 'flex-end',
  },
  gridLikeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 6,
    gap: 3,
  },
  gridLikeCount: {
    color: 'white',
    fontSize: 11,
    fontWeight: '600',
  },
});
