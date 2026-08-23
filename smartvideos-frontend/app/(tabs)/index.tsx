import React, { useEffect, useState, useRef, useCallback, useContext, useMemo } from 'react';
import { ActivityIndicator, Animated, Dimensions, FlatList, PanResponder, Pressable, RefreshControl, StyleSheet, Text, View, TouchableOpacity, useWindowDimensions, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
// @ts-ignore: optional dependency may not have type declarations in this environment
import * as Sharing from 'expo-sharing';
// @ts-ignore: optional dependency may not have type declarations in this environment
import Slider from '@react-native-community/slider';
import { useIsFocused, useFocusEffect } from '@react-navigation/native';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { Video } from 'expo-av';
import { useKeepAwake } from 'expo-keep-awake';
import useVideoPlayer, { useEvent } from '../lib/useVideoPlayer';
import { registerPlayer as globalRegisterPlayer, pauseAllExcept } from '../lib/playerRegistry';

import { getToken, toggleLike, toggleDislike, decodeTokenUserId, recordInteraction, reportVideo, deleteVideo } from '../lib/api';
import apiClient from '../lib/api';
import VideoPlayer from '../components/VideoPlayer';
import axios from 'axios';
import { Ionicons } from '@expo/vector-icons';
import CommentModal from '../components/comment-modal';
import AnimatedFlame from '../components/AnimatedFlame';
import ConfirmModal from '../components/ConfirmModal';
import ReportModal from '../components/ReportModal';
import { AuthContext } from '../lib/auth';
import { useVideoStore } from '../lib/videoStore';
import { useRouter } from 'expo-router';
import { useToast } from '../components/Toast';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

const styles = StyleSheet.create({
  container: {
    width: '100%',
    backgroundColor: 'black',
    position: 'relative',
  },
  videoContainer: {
    width: '100%',
    backgroundColor: 'black',
    position: 'relative',
  },
  video: {
    height: '100%',
    width: '100%',
  },
  placeholder: {
    width: '100%',
    height: '100%',
    backgroundColor: 'black',
    resizeMode: 'cover' as any,
  },
  overlayRight: {
    position: 'absolute',
    right: 10,
    bottom: 180,
    alignItems: 'center',
    zIndex: 99,
  },
  iconButton: {
    marginBottom: 12,
    alignItems: 'center',
  },
  bottomBar: {
    position: 'absolute',
    left: 12,
    bottom: 24,
    right: 80,
  },
  bottomOverlay: {
    position: 'absolute',
    left: 15,
    bottom: 100,
    width: '75%',
    zIndex: 99,
    right: 80,
    flexDirection: 'column',
    alignItems: 'flex-start',
    justifyContent: 'flex-start',
  },
  expandCompact: {
    position: 'absolute',
    right: 12,
    bottom: 20,
  },
  expandButton: {
    padding: 8,
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderRadius: 20,
  },
  videoOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 50,
  },
  iconShadow: {
    shadowColor: 'black',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.6,
    shadowRadius: 4,
    elevation: 6,
  },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },
  playIconBg: {
    backgroundColor: 'rgba(0,0,0,0.4)',
    padding: 12,
    borderRadius: 40,
  },
  watermark: {
    position: 'absolute',
    zIndex: 300,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
  },
  watermarkText: {
    color: 'white',
    fontWeight: '700',
  },
  progressBarContainer: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    zIndex: 150,
  },
  profilePic: {
    width: 48,
    height: 48,
    borderRadius: 24,
    overflow: 'hidden',
    marginRight: 10,
  },
  uploader: {
    color: 'white',
    fontWeight: '700',
  },
  description: {
    color: 'white',
    marginTop: 4,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  fireButton: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  fireText: {
    color: 'white',
    marginLeft: 6,
    fontWeight: '700',
  },
  plusButton: {
    padding: 8,
    transform: [{ translateY: 3 }],
  },
  userButton: {
    padding: 8,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  serverDownText: {
    color: 'white',
    marginBottom: 12,
  },
});

function ProfilePicInner({ raw }: { raw?: string }) {
  const uri = useMemo(() => {
    if (!raw) return null;
    const base = (apiClient.API_BASE_URL || '').replace(/\/$/, '');
    const absolute = String(raw).startsWith('http');
    return absolute ? raw : `${base}/${raw}`;
  }, [raw]);
  if (!uri) return null;
  return <ExpoImage source={{ uri }} style={styles.profilePic} contentFit="cover" cachePolicy="disk" onError={() => {
    console.warn('[Feed] Failed to load profile picture:', uri);
  }} />;
}

const ProfilePic = React.memo(ProfilePicInner, (a, b) => a.raw === b.raw);

function VideoDetailItem({ item, index, isFocused, shouldLoadSource, containerHeight, onToggleLike, onToggleDislike, onOpenComments, registerPlayer, onReady }: any) {
  const { user: authUser } = useContext(AuthContext);
  const videoStore = useVideoStore();
  const toast = useToast();
  const router = useRouter();
  const videoRef = useRef<any>(null);
  const accumulatedMsRef = useRef<number>(0);
  const lastPingMsRef = useRef<number>(0);
  const playingStartRef = useRef<number | null>(null);
  const inflightPingRef = useRef<boolean>(false);
  const [isVideoLoading, setIsVideoLoading] = useState<boolean>(false);
  const [videoUri, setVideoUri] = useState<string | null>(null);
  const [commentsVisible, setCommentsVisible] = useState(false);
  const [reportVisible, setReportVisible] = useState(false);
  const [reportVideoId, setReportVideoId] = useState<number | null>(null);
  const [reportInitialText, setReportInitialText] = useState<string | undefined>(undefined);
  const [isLikedByMe, setIsLikedByMe] = useState<boolean>(() => item?.is_liked ?? false);
  const [likesCount, setLikesCount] = useState<number>(() => item?.likes_count ?? 0);
  const serverCommentsInit = item?.comments_count ?? item?.comments ?? item?.comment_count ?? 0;
  const storedCommentsInit = videoStore.getVideo(item.id)?.comments_count ?? 0;
  const [commentCount, setCommentCount] = useState<number>(() => Math.max(Number(storedCommentsInit ?? 0), Number(serverCommentsInit ?? 0)));
  const [isDislikedByMe, setIsDislikedByMe] = useState<boolean>(() => item?.is_disliked ?? false);
  const [dislikesCount, setDislikesCount] = useState<number>(() => item?.dislikes_count ?? 0);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState<string | undefined>(undefined);
  const [confirmMessage, setConfirmMessage] = useState<string | undefined>(undefined);
  const confirmCallbackRef = useRef<() => Promise<void> | void>(() => {});

  useEffect(() => {
    try {
      setIsLikedByMe(Boolean(item?.is_liked ?? false));
      setLikesCount(item?.likes_count ?? 0);
      const serverVal = item?.comments_count ?? item?.comments ?? item?.comment_count ?? 0;
      const storedVal = videoStore.getVideo(item.id)?.comments_count ?? 0;
      setCommentCount(Math.max(Number(storedVal ?? 0), Number(serverVal ?? 0)));
      setIsDislikedByMe(Boolean(item?.is_disliked ?? false));
      setDislikesCount(item?.dislikes_count ?? 0);
    } catch (e) {}
  }, [item?.id, item?.is_liked, item?.is_disliked, item?.likes_count, item?.dislikes_count, item?.comments_count]);

  useEffect(() => {
    try {
      registerPlayer?.(item.id, videoRef);
      globalRegisterPlayer(item.id, videoRef);
    } catch (e) {}
    return () => {
      try {
        registerPlayer?.(item.id, undefined);
        globalRegisterPlayer(item.id, undefined);
      } catch (e) {}
    };
  }, [item.id, registerPlayer, videoRef]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const t = await getToken();
        if (mounted) setAuthToken(t ?? null);
      } catch (e) {}
    })();
    return () => { mounted = false; };
  }, [item.id]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        if (!item || !item.filename) return;
        const uri = await import('../lib/videoCache').then(m => m.getPlayableUri(item.filename));
        if (mounted) setVideoUri(uri);
      } catch (e) {
        try { console.warn('video cache failed', e); } catch (e2) {}
      }
    })();
    return () => { mounted = false; };
  }, [item?.filename, authToken]);

  useEffect(() => {
    try {
      if (item && item.id && isFocused) pauseAllExcept(item.id);
    } catch (e) {}
  }, [item, isFocused]);

  useEffect(() => {
    if (isFocused && videoUri && videoRef.current) {
      try {
        const player: any = videoRef.current;
        if (typeof player.playAsync === 'function') {
          player.playAsync().catch(() => {});
        }
      } catch (e) {}
    }
  }, [isFocused, videoUri]);

  useEffect(() => {
    return () => {
      (async () => {
        try {
          const now = Date.now();
          if (playingStartRef.current != null) {
            accumulatedMsRef.current += now - playingStartRef.current;
            playingStartRef.current = null;
          }
          const remaining = accumulatedMsRef.current - lastPingMsRef.current;
          if (remaining > 0) {
            try {
              const token = await getToken();
              const userId = decodeTokenUserId(token || undefined);
              if (userId) {
                await recordInteraction(item.id, Math.max(0, Math.floor(remaining)));
                lastPingMsRef.current += remaining;
              }
            } catch (e) {}
          }
        } catch (e) {}
      })();
    };
  }, [item?.id]);

  const [downloading, setDownloading] = useState(false);
  const watermarkIntervalRef = useRef<any>(null);

  const handleDownload = async (itemParam: any) => {
    try {
      try { toast.show('Download started'); } catch (e) {}
      if (downloading) return;
      if (!itemParam) { try { toast.show('No video available'); } catch (e) {} ; return; }
      setDownloading(true);

      const base = (apiClient.API_BASE_URL || '').replace(/\/$/, '');
      const uri = itemParam.url || `${base}/video/${itemParam.filename}`;

      try {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), 5000);
        const headResp = await fetch(uri, { method: 'HEAD', signal: ac.signal } as any);
        clearTimeout(to);
        if (!headResp.ok && headResp.status !== 200) throw new Error('Resource not available');
      } catch (err) {}

      const filename = itemParam.filename || `video_${Date.now()}.mp4`;
      const baseDir = (FileSystem as any).cacheDirectory ?? (FileSystem as any).documentDirectory ?? '';
      let dl: any = null;
      if (!baseDir) {
        try {
          const { Share, Linking } = await import('react-native');
          if (Share && typeof Share.share === 'function') {
            await Share.share({ message: uri, url: uri });
            try { toast.show('Download complete (shared)'); } catch (e) {}
            return;
          }
          if (Linking && typeof Linking.openURL === 'function') {
            try { await Linking.openURL(uri); } catch (e) {}
            try { toast.show('Opened in browser for download'); } catch (e) {}
            return;
          }
        } catch (e) {}

        const SharingModule = await import('expo-sharing').then(m => m.default || m).catch(() => null);
        if (SharingModule && typeof SharingModule.shareAsync === 'function') {
          try { await SharingModule.shareAsync(uri); } catch (e) {}
          try { toast.show('Download complete (shared)'); } catch (e) {}
          return;
        }

        throw new Error('Unable to access file system directories');
      } else {
        const dest = baseDir + filename;
        dl = await FileSystem.downloadAsync(uri, dest);
      }

      if (!MediaLibrary || typeof MediaLibrary.requestPermissionsAsync !== 'function') {
        const SharingModule = await import('expo-sharing').then(m => m.default || m).catch(() => null);
        if (SharingModule && typeof SharingModule.shareAsync === 'function') await SharingModule.shareAsync(dl.uri);
        try { toast.show('Download complete'); } catch (e) {}
        return;
      }

      try {
        const { status } = await MediaLibrary.requestPermissionsAsync(true, ['video']);
        if (status === 'granted') {
          if (typeof MediaLibrary.saveToLibraryAsync === 'function') {
            await MediaLibrary.saveToLibraryAsync(dl.uri);
          } else if (typeof MediaLibrary.createAssetAsync === 'function') {
            const asset = await MediaLibrary.createAssetAsync(dl.uri);
            try { if (typeof MediaLibrary.createAlbumAsync === 'function') await MediaLibrary.createAlbumAsync('SmartVideos', asset, false); } catch (e) {}
          } else {
            const SharingModule = await import('expo-sharing').then(m => m.default || m).catch(() => null);
            if (SharingModule && typeof SharingModule.shareAsync === 'function') await SharingModule.shareAsync(dl.uri);
          }
          try { toast.show('Download complete'); } catch (e) {}
        } else {
          const SharingModule = await import('expo-sharing').then(m => m.default || m).catch(() => null);
          if (SharingModule && typeof SharingModule.shareAsync === 'function') await SharingModule.shareAsync(dl.uri);
          try { toast.show('Download complete'); } catch (e) {}
        }
      } catch (err) {
        const SharingModule = await import('expo-sharing').then(m => m.default || m).catch(() => null);
        if (SharingModule && typeof SharingModule.shareAsync === 'function') await SharingModule.shareAsync(dl.uri);
        try { toast.show('Download complete'); } catch (e) {}
      }
    } catch (e: any) {
      try { toast.show('Download failed: ' + (e?.message || String(e))); } catch (e2) {}
    } finally {
      setDownloading(false);
      if (watermarkIntervalRef.current) {
        clearInterval(watermarkIntervalRef.current);
        watermarkIntervalRef.current = null;
      }
    }
  };

  const onPlaybackStatusUpdate = useCallback(async (status: any) => {
    try {
      const now = Date.now();
      const isPlaying = Boolean(status?.isPlaying || status?.shouldPlay);
      if (isPlaying) {
        if (playingStartRef.current == null) {
          playingStartRef.current = now;
        }
      } else {
        if (playingStartRef.current != null) {
          accumulatedMsRef.current += now - playingStartRef.current;
          playingStartRef.current = null;
        }
      }
      const currentTotal = accumulatedMsRef.current + (playingStartRef.current != null ? (now - playingStartRef.current) : 0);
      const deltaSinceLastPing = currentTotal - lastPingMsRef.current;
      if (deltaSinceLastPing >= 5000) {
        const toSend = Math.floor(deltaSinceLastPing / 5000) * 5000;
        if (!inflightPingRef.current) {
          inflightPingRef.current = true;
          try {
            const token = await getToken();
            const userId = decodeTokenUserId(token || undefined);
            if (userId) {
              await recordInteraction(item.id, toSend);
              lastPingMsRef.current += toSend;
            }
          } catch (e) {} finally {
            inflightPingRef.current = false;
          }
        }
      }
    } catch (e) {}
  }, [item]);

  const uploaderLabel = '@' + (item?.username || 'Unknown');

  // Compute poster image for thumbnail preview before focused stream starts
  const thumbnailUri = useMemo(() => {
    const base = (apiClient.API_BASE_URL || '').replace(/\/$/, '');
    const raw = item.thumbnail || item.poster || item.profile_pic_url;
    if (!raw) return undefined;
    return String(raw).startsWith('http') ? raw : `${base}/${String(raw).replace(/^\//, '')}`;
  }, [item]);

  const resolvedSourceUri = useMemo(() => {
    if (videoUri) return videoUri;
    const base = (apiClient.API_BASE_URL || '').replace(/\/$/, '');
    return item?.filename ? `${base}/video/${item.filename}` : undefined;
  }, [videoUri, item?.filename]);

  return (
    <View style={[styles.container, { height: containerHeight }]}>
    <VideoPlayer
    id={item.id}
    playerRef={videoRef}
    style={StyleSheet.absoluteFill}
    source={shouldLoadSource && resolvedSourceUri ? { uri: resolvedSourceUri } : undefined}
    posterSource={thumbnailUri ? { uri: thumbnailUri } : undefined}
    shouldPlay={isFocused && shouldLoadSource}
    onDoubleTap={() => { try { onToggleLike?.(item.id); } catch (e) {} }}
    onLongPress={() => {
      try {
        const isOwner = authUser && item?.uploader_id && authUser.id === item.uploader_id;
        if (isOwner) {
          setConfirmTitle('Delete video');
          setConfirmMessage('Are you sure you want to delete this video?');
          confirmCallbackRef.current = async () => {
            try {
              await deleteVideo(item.id);
              try { videoStore.updateVideo(item.id, { deleted: true }); } catch (e) {}
              try { toast.show('Video deleted'); } catch (e) {}
            } catch (e: any) {
              try { toast.show(e?.response?.data?.error || 'Delete failed'); } catch (e2) {}
            }
          };
          setConfirmVisible(true);
        } else {
          try {
            setReportVideoId(item.id);
            setReportInitialText(undefined);
            setReportVisible(true);
          } catch (e) {}
        }
      } catch (e) {}
    }}
    onPlaybackStatusUpdate={onPlaybackStatusUpdate}
    onReady={() => { try { if (onReady) onReady(); } catch (e) {} }}
    />

    <View style={{ position: 'absolute', right: 10, bottom: 180, zIndex: 99, alignItems: 'center' }} pointerEvents="box-none">
    <TouchableOpacity onPress={() => { try { onToggleLike?.(item.id); } catch (e) {} }} style={styles.iconButton}>
    <Ionicons name={isLikedByMe ? 'heart' : 'heart-outline'} size={34} color={isLikedByMe ? 'red' : 'white'} style={styles.iconShadow} />
    <Text style={{ color: 'white', textAlign: 'center' }}>{likesCount ?? 0}</Text>
    </TouchableOpacity>

    <TouchableOpacity onPress={() => { try { onToggleDislike?.(item.id); } catch (e) {} }} style={styles.iconButton}>
    <Ionicons name={isDislikedByMe ? 'heart-dislike' : 'heart-dislike-outline'} size={28} color={isDislikedByMe ? 'red' : 'white'} style={styles.iconShadow} />
    <Text style={{ color: 'white', textAlign: 'center' }}>{dislikesCount ?? 0}</Text>
    </TouchableOpacity>

    <TouchableOpacity onPress={() => setCommentsVisible(true)} style={styles.iconButton}>
    <Ionicons name="chatbubble" size={28} color="white" style={styles.iconShadow} />
    <Text style={{ color: 'white', textAlign: 'center' }}>{commentCount ?? 0}</Text>
    </TouchableOpacity>

    <TouchableOpacity onPress={() => { try { handleDownload(item); } catch (e) {} }} style={styles.iconButton}>
    <Ionicons name="download" size={28} color="white" style={styles.iconShadow} />
    <Text style={{ color: 'white', textAlign: 'center' }}>Save</Text>
    </TouchableOpacity>
    </View>

    {isVideoLoading && (
      <View pointerEvents="none" style={[StyleSheet.absoluteFillObject, { alignItems: 'center', justifyContent: 'center', zIndex: 20 }]}>
      <ActivityIndicator size="large" color="#ff4500" />
      </View>
    )}

    <View style={styles.bottomOverlay} pointerEvents="box-none">
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
    {(() => {
      let raw = item?.profile_pic_url || null;
      if (authUser && item.uploader_id && authUser.id === item.uploader_id && authUser.profile_pic_url) raw = authUser.profile_pic_url;
      if (raw) {
        const base = (apiClient.API_BASE_URL || '').replace(/\/$/, '');
        const absolute = String(raw).startsWith('http');
        const url = absolute ? raw : `${base}/${raw}`;
        return <ExpoImage source={{ uri: url }} style={styles.profilePic} contentFit="cover" cachePolicy="disk" />;
      }
      return (
        <View style={[styles.profilePic, { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.12)' }]}>
        <Ionicons name="person-circle" size={24} color="white" />
        </View>
      );
    })()}

    <TouchableOpacity onPress={() => { try { router.push({ pathname: '/profile', params: { user_id: String(item.uploader_id) } }); } catch (e) {} }} style={{ marginLeft: 6 }}>
    <Text style={[styles.uploader]}>{uploaderLabel}</Text>
    </TouchableOpacity>
    </View>

    <View style={{ marginTop: 6, marginLeft: 12 }}>
    <Text style={styles.description} numberOfLines={2}>{item.description}</Text>
    </View>
    </View>

    {commentsVisible && (
      <CommentModal visible={commentsVisible} videoId={item.id} onClose={() => setCommentsVisible(false)} onCommentsUpdated={(videoId, newCount) => {
        setCommentCount(newCount);
        try { videoStore.updateVideo(item.id, { comments_count: newCount }); } catch (e) {}
      }} />
    )}
    {reportVisible && (
      <ReportModal visible={reportVisible} initialText={reportInitialText} title="Report video" message="Please describe the issue (optional):" onCancel={() => { setReportVisible(false); setReportVideoId(null); }} onSubmit={async (text) => {
        try {
          setReportVisible(false);
          const vid = reportVideoId;
          setReportVideoId(null);
          if (!vid) return;
          await reportVideo(vid, text || 'Reported via app');
          try { toast.show('Reported'); } catch (e) {}
        } catch (e: any) {
          try { toast.show(e?.response?.data?.error || 'Report failed'); } catch (e2) {}
        }
      }} />
    )}
    <ConfirmModal
    visible={confirmVisible}
    title={confirmTitle}
    message={confirmMessage}
    onCancel={() => setConfirmVisible(false)}
    onConfirm={async () => {
      try { setConfirmVisible(false); await confirmCallbackRef.current(); } catch (e) {}
    }}
    />
    </View>
  );
}

export default function FeedScreen() {
  useKeepAwake();

  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  let tabBarHeight = 49;
  try {
    tabBarHeight = useBottomTabBarHeight();
  } catch (e) {}
  const containerHeight = Math.max(100, Math.floor(windowHeight - (insets?.top || 0) - (tabBarHeight || 0)));
  const videoStore = useVideoStore();
  const router = useRouter();
  const toast = useToast();
  const flatListRef = useRef<FlatList>(null);

  const [videos, setVideos] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);

  async function fetchVideos() {
    setRefreshing(true);
    try {
      const token = await getToken();
      const userId = decodeTokenUserId(token || undefined);
      const client = apiClient.getApiClient(token ?? undefined);
      const params: any = userId ? { user_id: userId } : {};
      params.t = Date.now();
      const resp = await client.get('/personalized_feed', { params });
      let allVideos = resp.data.videos || [];

      const normalized = allVideos.map((v: any) => {
        const storedVideo = videoStore.getVideo(v.id);
        const serverComments = v.comments_count ?? v.comments ?? v.comment_count ?? 0;
        return {
          ...v,
          comments_count: Math.max(Number(storedVideo?.comments_count ?? 0), Number(serverComments ?? 0)),
          likes_count: storedVideo?.likes_count ?? v.likes_count,
          is_liked: typeof v.is_liked === 'boolean' ? v.is_liked : (storedVideo?.is_liked ?? false),
          dislikes_count: storedVideo?.dislikes_count ?? v.dislikes_count ?? 0,
          is_disliked: typeof v.is_disliked === 'boolean' ? v.is_disliked : (storedVideo?.is_disliked ?? false),
        };
      });

      try { videoStore.setVideos(normalized); } catch (e) {}
      setVideos(normalized);
    } catch (e) {
      console.error('FeedScreen: Failed to fetch videos', e);
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }

  const { user: authUser } = useContext(AuthContext);

  useEffect(() => { fetchVideos(); }, [authUser?.id]);

  const isScreenFocused = useIsFocused();

  const handleToggleLike = useCallback(
    async (videoId: number) => {
      try {
        const token = await getToken();
        const userId = decodeTokenUserId(token || undefined);
        if (!userId) {
          try { toast.show('Sign in to like videos'); } catch (e) {}
          return;
        }

        setVideos((vs) =>
        vs.map((v) => {
          if (v.id !== videoId) return v;
          const currentlyLiked = Boolean(v?.is_liked ?? v?.liked);
          const newLiked = !currentlyLiked;
          const newLikes = typeof v.likes_count === 'number' ? Math.max(0, v.likes_count + (newLiked ? 1 : -1)) : newLiked ? 1 : 0;
          const updated = { ...v, likes_count: newLikes, liked: newLiked, is_liked: newLiked };
          try { videoStore.updateVideo(videoId, { likes_count: updated.likes_count, is_liked: updated.is_liked, liked: updated.liked }); } catch (e) {}
          return updated;
        })
        );

        const resp = await toggleLike(videoId);
        const likedNow = resp?.is_liked;
        const likes = resp?.likes_count;
        const dislikes = resp?.dislikes_count;
        const isDisliked = resp?.is_disliked;

        setVideos((vs) =>
        vs.map((v) => {
          if (v.id !== videoId) return v;
          return {
            ...v,
            likes_count: typeof likes === 'number' ? Math.max(0, likes) : v.likes_count,
            dislikes_count: typeof dislikes === 'number' ? Math.max(0, dislikes) : v.dislikes_count,
            liked: typeof likedNow === 'boolean' ? likedNow : Boolean(v.is_liked),
            is_liked: typeof likedNow === 'boolean' ? likedNow : Boolean(v.is_liked),
            is_disliked: typeof isDisliked === 'boolean' ? isDisliked : Boolean(v.is_disliked),
          };
        })
        );

        try { videoStore.updateVideo(videoId, { likes_count: typeof likes === 'number' ? likes : undefined, dislikes_count: typeof dislikes === 'number' ? dislikes : undefined, is_liked: typeof likedNow === 'boolean' ? likedNow : undefined, is_disliked: Boolean(isDisliked) }); } catch (e) {}
      } catch (e) {
        console.error('Feed: Toggle like failed', e);
      }
    },
    [toast, videoStore]
  );

  const handleToggleDislike = useCallback(
    async (videoId: number) => {
      try {
        const token = await getToken();
        const userId = decodeTokenUserId(token || undefined);
        if (!userId) {
          try { toast.show('Sign in to dislike videos'); } catch (e) {}
          return;
        }

        setVideos((vs) =>
        vs.map((v) => {
          if (v.id !== videoId) return v;
          const currentlyDisliked = Boolean(v?.is_disliked);
          const newDisliked = !currentlyDisliked;
          const newLikes = typeof v.likes_count === 'number' ? Math.max(0, v.likes_count + (newDisliked ? -1 : 0)) : v.likes_count;
          const newDislikes = typeof v.dislikes_count === 'number' ? Math.max(0, v.dislikes_count + (newDisliked ? 1 : -1)) : (newDisliked ? 1 : 0);
          return { ...v, is_disliked: newDisliked, dislikes_count: newDislikes, is_liked: newDisliked ? false : v.is_liked, likes_count: newLikes };
        })
        );

        const resp = await toggleDislike(videoId);
        const isDisliked = resp?.is_disliked;
        const likes = resp?.likes_count;
        const dislikes = resp?.dislikes_count;
        const likedFromResp = resp?.is_liked;

        setVideos((vs) =>
        vs.map((v) => {
          if (v.id !== videoId) return v;
          return {
            ...v,
            likes_count: typeof likes === 'number' ? Math.max(0, likes) : v.likes_count,
            dislikes_count: typeof dislikes === 'number' ? Math.max(0, dislikes) : v.dislikes_count,
            is_disliked: typeof isDisliked === 'boolean' ? isDisliked : Boolean(v.is_disliked),
            is_liked: typeof likedFromResp === 'boolean' ? likedFromResp : v.is_liked,
          };
        })
        );

        try { videoStore.updateVideo(videoId, { likes_count: typeof likes === 'number' ? likes : undefined, dislikes_count: typeof dislikes === 'number' ? dislikes : undefined, is_disliked: typeof isDisliked === 'boolean' ? isDisliked : undefined, is_liked: typeof likedFromResp === 'boolean' ? likedFromResp : undefined }); } catch (e) {}
      } catch (e) {
        console.error('Feed: Toggle dislike failed', e);
      }
    },
    [toast, videoStore]
  );

  const handleCommentsUpdated = (videoId: number | null, newCount: number) => {
    if (!videoId) return;
    setVideos(vs => vs.map(v => v.id === videoId ? { ...v, comments_count: newCount } : v));
    try { videoStore.updateVideo(videoId, { comments_count: newCount }); } catch (e) {}
  };

  const handleScroll = (event: any) => {
    const contentOffsetY = event.nativeEvent.contentOffset.y;
    const index = Math.round(contentOffsetY / containerHeight);
    setCurrentIndex(Math.max(0, Math.min(index, videos.length - 1)));
  };

  if (loading) {
    return (
      <View style={[styles.container, { height: containerHeight }]}>
      <ActivityIndicator size="large" color="#FF4500" />
      </View>
    );
  }

  if (videos.length === 0) {
    return (
      <View style={[styles.container, { height: containerHeight }]}>
      <Text style={{ color: 'white' }}>No videos available</Text>
      <TouchableOpacity onPress={() => router.push('/upload')} style={{ marginTop: 12 }}>
      <Text style={{ color: '#1e90ff' }}>Upload</Text>
      </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
    <View style={{ paddingHorizontal: 12, paddingTop: 6, backgroundColor: 'black' }}>
    <View style={styles.topBar}>
    <TouchableOpacity onPress={() => fetchVideos()} style={styles.fireButton}>
    <Ionicons name="flame" size={18} color="white" />
    <Text style={styles.fireText}>FIRE</Text>
    </TouchableOpacity>

    <TouchableOpacity onPress={() => router.push('/upload')} style={styles.plusButton}>
    <Ionicons name="add" size={24} color="white" />
    </TouchableOpacity>

    <TouchableOpacity onPress={() => router.push('/profile')} style={styles.userButton}>
    <Ionicons name="person-circle-outline" size={28} color="white" />
    </TouchableOpacity>
    </View>
    </View>

    <FlatList
    ref={flatListRef}
    data={videos}
    extraData={videos}
    keyExtractor={v => String(v.id)}
    renderItem={({ item, index }) => (
      <VideoDetailItem
      item={item}
      index={index}
      isFocused={(index === currentIndex) && isScreenFocused}
      shouldLoadSource={Math.abs(index - currentIndex) <= 1}
      containerHeight={containerHeight}
      onToggleLike={(id:number) => { try { handleToggleLike(id); } catch (e) {} }}
      onToggleDislike={(id:number) => { try { handleToggleDislike(id); } catch (e) {} }}
      onOpenComments={() => {}}
      onCommentsUpdated={(videoId:number|null, newCount:number) => { try { handleCommentsUpdated(videoId, newCount); } catch (e) {} }}
      registerPlayer={undefined}
      onReady={() => {}}
      />
    )}
    pagingEnabled={true}
    snapToInterval={containerHeight}
    showsVerticalScrollIndicator={false}
    decelerationRate="fast"
    disableIntervalMomentum={true}
    snapToAlignment="start"
    onScroll={handleScroll}
    scrollEventThrottle={16}
    initialScrollIndex={currentIndex}
    getItemLayout={(data, index) => ({
      length: containerHeight,
      offset: containerHeight * index,
      index,
    })}
    refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => fetchVideos()} colors={["#FF4500"]} progressBackgroundColor="#000" />}
    />
    </View>
  );
}
