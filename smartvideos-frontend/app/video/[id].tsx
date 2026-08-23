import React, { useContext, useEffect, useRef, useState, useCallback } from 'react';
import { ActivityIndicator, View, TouchableOpacity, useWindowDimensions, StyleSheet, Text, FlatList, Alert } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import ConfirmModal from '../components/ConfirmModal';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import VideoPlayer from '../components/VideoPlayer';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import CommentModal from '../components/comment-modal';
import ReportModal from '../components/ReportModal';
import { getToken, toggleLike, toggleDislike, decodeTokenUserId, recordInteraction, reportVideo, deleteVideo } from '../lib/api';
import apiClient from '../lib/api';
import { AuthContext } from '../lib/auth';
import { useToast } from '../components/Toast';
import { useVideoStore } from '../lib/videoStore';
import { pauseAllExcept } from '../lib/playerRegistry';

export const options = {
  headerShown: false,
};

function VideoDetailItem({ item, isFocused, containerHeight, onDownload, onCommentsUpdated }: any) {
  const { forcePlay } = item || {};
  const { user: authUser } = useContext(AuthContext);
  const router = useRouter();
  const videoStore = useVideoStore();
  const toast = useToast();
  const videoRef = useRef<any>(null);
  const accumulatedMsRef = useRef<number>(0);
  const lastPingMsRef = useRef<number>(0);
  const playingStartRef = useRef<number | null>(null);
  const inflightPingRef = useRef<boolean>(false);
  const [isVideoLoading, setIsVideoLoading] = useState<boolean>(false);
  const [videoUri, setVideoUri] = useState<string | null>(null);
  const [commentsVisible, setCommentsVisible] = useState(false);
  const [reportVisible, setReportVisible] = useState(false);
  const [reportInitialText, setReportInitialText] = useState<string | undefined>(undefined);
  const [isLikedByMe, setIsLikedByMe] = useState<boolean>(() => item?.is_liked ?? false);
  const [likesCount, setLikesCount] = useState<number>(() => item?.likes_count ?? 0);
  const serverCommentsInit = item?.comments_count ?? item?.comments ?? item?.comment_count ?? 0;
  const storedCommentsInit = (useVideoStore().getVideo(item.id)?.comments_count) ?? 0;
  const [commentCount, setCommentCount] = useState<number>(() => Math.max(Number(storedCommentsInit ?? 0), Number(serverCommentsInit ?? 0)));
  const [isDislikedByMe, setIsDislikedByMe] = useState<boolean>(() => item?.is_disliked ?? false);
  const [dislikesCount, setDislikesCount] = useState<number>(() => item?.dislikes_count ?? 0);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [confirmVisible, setConfirmVisible] = useState<boolean>(false);
  const [confirmTitle, setConfirmTitle] = useState<string>('');
  const [confirmMessage, setConfirmMessage] = useState<string>('');
  const confirmCallbackRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    try {
      setIsLikedByMe(Boolean(item?.is_liked ?? false));
      setIsDislikedByMe(Boolean(item?.is_disliked ?? false));
      setLikesCount(item?.likes_count ?? 0);
      setDislikesCount(item?.dislikes_count ?? 0);
    } catch (e) {}
  }, [item?.id, item?.is_liked, item?.is_disliked, item?.likes_count, item?.dislikes_count]);

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
      if (item && item.id) pauseAllExcept(item.id);
    } catch (e) {}
  }, [item]);

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

  function handleLongPress() {
    try {
      const isOwner = authUser && item?.uploader_id && authUser.id === item.uploader_id;
      if (isOwner) {
        try {
          setConfirmTitle('Delete video');
          setConfirmMessage('Are you sure you want to delete this video?');
          confirmCallbackRef.current = async () => {
            try {
              await deleteVideo(item.id);
              try { toast.show('Video deleted'); } catch (e) {}
              try { videoStore.updateVideo(item.id, { deleted: true }); } catch (e) {}
              try { router.back(); } catch (e) {}
            } catch (e: any) {
              try { toast.show(e?.response?.data?.error || 'Delete failed'); } catch (e2) {}
            }
          };
          setConfirmVisible(true);
        } catch (e) {}
      } else {
        try {
          setReportInitialText(undefined);
          setReportVisible(true);
        } catch (e) {}
      }
    } catch (e) {}
  }

  useEffect(() => {
    if (videoUri && videoRef.current && (item?.forcePlay === true || item?.initialPlay === '1')) {
      try {
        const player: any = videoRef.current;
        if (typeof player.playAsync === 'function') player.playAsync().catch(() => {});
      } catch (e) {}
    }
  }, [videoUri, item?.forcePlay, item?.initialPlay]);

  useEffect(() => {
    return () => {
      try {
        const player: any = videoRef?.current;
        if (player && typeof player.pauseAsync === 'function') player.pauseAsync().catch(() => {});
      } catch (e) {}
    };
  }, [videoRef]);

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

  async function handleToggleLike() {
    try {
      const token = await getToken();
      const userId = decodeTokenUserId(token || undefined);
      if (!userId) {
        try { toast.show('Sign in to like videos'); } catch (e) {}
        return;
      }

      const wasPreviouslyLiked = isLikedByMe;
      const wasPreviousCount = likesCount;
      try {
        setIsLikedByMe(!isLikedByMe);
        setLikesCount(prev => !isLikedByMe ? (prev || 0) + 1 : Math.max(0, (prev || 0) - 1));

        const resp = await toggleLike(item.id);
        const finalLiked = Boolean(resp?.is_liked ?? wasPreviouslyLiked);
        const likesFromResponse = resp?.likes_count;
        const finalDisliked = Boolean(resp?.is_disliked ?? false);
        const dislikesFromResponse = resp?.dislikes_count;

        setIsLikedByMe(finalLiked);
        if (typeof likesFromResponse === 'number') setLikesCount(likesFromResponse);

        setIsDislikedByMe(finalDisliked);
        if (typeof dislikesFromResponse === 'number') setDislikesCount(dislikesFromResponse);

        try {
          videoStore.updateVideo(item.id, {
            is_liked: finalLiked,
            likes_count: typeof likesFromResponse === 'number' ? likesFromResponse : undefined,
            is_disliked: finalDisliked,
            dislikes_count: typeof dislikesFromResponse === 'number' ? dislikesFromResponse : undefined,
          });
        } catch (e) {}
      } catch (e) {
        setIsLikedByMe(wasPreviouslyLiked);
        setLikesCount(wasPreviousCount);
      }
    } catch (e) {
      console.error('Like failed', e);
    }
  }

  async function handleToggleDislike() {
    try {
      const token = await getToken();
      const userId = decodeTokenUserId(token || undefined);
      if (!userId) {
        try { toast.show('Sign in to dislike videos'); } catch (e) {}
        return;
      }

      const wasPreviouslyDisliked = isDislikedByMe;
      const wasPreviousDislikes = dislikesCount;
      const wasPreviouslyLiked = isLikedByMe;
      const wasPreviousLikes = likesCount;
      try {
        const newDisliked = !isDislikedByMe;
        setIsDislikedByMe(newDisliked);
        setDislikesCount(d => newDisliked ? (d || 0) + 1 : Math.max(0, (d || 0) - 1));
        if (newDisliked && isLikedByMe) {
          setIsLikedByMe(false);
          setLikesCount(l => Math.max(0, (l || 0) - 1));
        }

        const resp = await toggleDislike(item.id);
        const isDisliked = Boolean(resp?.is_disliked ?? false);
        const dislikesFromResponse = resp?.dislikes_count;
        const likesFromResponse = resp?.likes_count;
        const likedFromResp = resp?.is_liked;

        setIsDislikedByMe(isDisliked);
        if (typeof dislikesFromResponse === 'number') setDislikesCount(dislikesFromResponse);
        if (typeof likesFromResponse === 'number') setLikesCount(likesFromResponse);
        if (typeof likedFromResp === 'boolean') setIsLikedByMe(likedFromResp);

        try {
          videoStore.updateVideo(item.id, {
            is_disliked: isDisliked,
            dislikes_count: typeof dislikesFromResponse === 'number' ? dislikesFromResponse : undefined,
            likes_count: typeof likesFromResponse === 'number' ? likesFromResponse : undefined,
            is_liked: typeof likedFromResp === 'boolean' ? likedFromResp : undefined,
          });
        } catch (e) {}
      } catch (e) {
        setIsDislikedByMe(wasPreviouslyDisliked);
        setDislikesCount(wasPreviousDislikes);
        setIsLikedByMe(wasPreviouslyLiked);
        setLikesCount(wasPreviousLikes);
      }
    } catch (e) {
      console.error('Dislike failed', e);
    }
  }

  async function handleCommentsUpdatedLocal(videoId: number | null, newCount: number) {
    setCommentCount(newCount);
    onCommentsUpdated?.(videoId, newCount);
  }

  return (
    <View style={[styles.container, { height: containerHeight }]}>
      <VideoPlayer
        id={item.id}
        source={{ uri: videoUri || (() => {
          const base = (apiClient.API_BASE_URL || '').replace(/\/$/, '');
          return `${base}/video/${item.filename}?cache_bust=${Date.now()}`;
        })() }}
        shouldPlay={isFocused}
        onDoubleTap={handleToggleLike}
        onLongPress={handleLongPress}
        onPlaybackStatusUpdate={onPlaybackStatusUpdate}
      />

      <View style={{ position: 'absolute', right: 10, bottom: 180, zIndex: 99, alignItems: 'center' }} pointerEvents="box-none">
        <TouchableOpacity onPress={handleToggleLike} style={styles.iconButton}>
          <Ionicons name={isLikedByMe ? 'heart' : 'heart-outline'} size={34} color={isLikedByMe ? 'red' : 'white'} style={styles.iconShadow} />
          <Text style={{ color: 'white', textAlign: 'center' }}>{likesCount}</Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={handleToggleDislike} style={styles.iconButton}>
          <Ionicons name={isDislikedByMe ? 'heart-dislike' : 'heart-dislike-outline'} size={28} color={isDislikedByMe ? 'red' : 'white'} style={styles.iconShadow} />
          <Text style={{ color: 'white', textAlign: 'center' }}>{dislikesCount ?? 0}</Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => setCommentsVisible(true)} style={styles.iconButton}>
          <Ionicons name="chatbubble" size={28} color="white" style={styles.iconShadow} />
          <Text style={{ color: 'white', textAlign: 'center' }}>{commentCount}</Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => onDownload?.(item)} style={styles.iconButton}>
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
        <View style={{ flexDirection: 'column' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {(() => {
            let raw = item?.profile_pic_url || null;
            if (authUser && item?.uploader_id && authUser.id === item.uploader_id && authUser.profile_pic_url) raw = authUser.profile_pic_url;
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

            <TouchableOpacity onPress={() => {
              try { router.push({ pathname: '/profile', params: { user_id: String(item.uploader_id) } }); } catch (e) {}
            }} style={{ marginLeft: 6 }}>
              <Text style={[styles.uploader]}>{uploaderLabel}</Text>
            </TouchableOpacity>
          </View>

          <View style={{ marginTop: 6, marginLeft: 12 }}>
            <Text style={styles.description} numberOfLines={2}>{item.description}</Text>
          </View>
        </View>
      </View>

      {commentsVisible && (
        <CommentModal visible={commentsVisible} videoId={item.id} onClose={() => setCommentsVisible(false)} onCommentsUpdated={handleCommentsUpdatedLocal} />
      )}
      {reportVisible && (
        <ReportModal visible={reportVisible} initialText={reportInitialText} onCancel={() => { setReportVisible(false); }} onSubmit={async (text) => {
          try {
            setReportVisible(false);
            await reportVideo(item.id, text || 'Reported via app');
            try { toast.show('Reported'); } catch (e) {}
          } catch (e: any) {
            try { toast.show(e?.response?.data?.error || 'Report failed'); } catch (e) {}
          }
        }} />
      )}
      <ConfirmModal visible={confirmVisible} title={confirmTitle} message={confirmMessage} onCancel={() => setConfirmVisible(false)} onConfirm={async () => {
        try { setConfirmVisible(false); await confirmCallbackRef.current(); } catch (e) {}
      }} />
    </View>
  );
}

export default function SingleVideoScreen() {
  const params = useLocalSearchParams() as any;
  const { id, uploader_id, initialPlaying, initialIndex } = params;
  const videoStore = useVideoStore();
  const router = useRouter();
  const { height } = useWindowDimensions();
  const { user: authUser } = useContext(AuthContext);
  const containerHeight = Math.max(100, Math.floor(height));
  const [videos, setVideos] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const watermarkIntervalRef = useRef<any>(null);
  const toast = useToast();
  const flatListRef = useRef<FlatList>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const token = await getToken();
        const userId = decodeTokenUserId(token || undefined);
        const client = apiClient.getApiClient(token ?? undefined);
        const params: any = userId ? { user_id: userId } : {};
        params.t = Date.now();
        const resp = await client.get('/personalized_feed', { params });
        let allVideos = resp.data.videos || [];

        if (uploader_id) {
          allVideos = allVideos.filter((v: any) => String(v.uploader_id) === String(uploader_id));
        }

        const normalized = allVideos.map((v: any) => {
          const storedVideo = videoStore.getVideo(v.id);
          return {
            ...v,
            comments_count: Math.max(Number(storedVideo?.comments_count ?? 0), Number((v.comments_count ?? v.comments ?? v.comment_count ?? 0) ?? 0)),
            likes_count: storedVideo?.likes_count ?? v.likes_count,
            is_liked: v.is_liked ?? storedVideo?.is_liked ?? false,
            initialPlay: String(v.id) === String(id) && String(initialPlaying) === '1' ? '1' : undefined,
            dislikes_count: storedVideo?.dislikes_count ?? v.dislikes_count ?? 0,
            is_disliked: v.is_disliked ?? storedVideo?.is_disliked ?? false,
          };
        });

        try { videoStore.setVideos(normalized); } catch (e) {}
        setVideos(normalized);

        let resolvedIndex = -1;
        if (initialIndex != null && initialIndex !== undefined) {
          const asNum = Number(initialIndex);
          if (!Number.isNaN(asNum) && asNum >= 0 && asNum < allVideos.length) {
            resolvedIndex = asNum;
          }
        }
        if (resolvedIndex === -1) {
          resolvedIndex = allVideos.findIndex((v: any) => String(v.id) === String(id));
        }
        if (resolvedIndex >= 0) {
          setCurrentIndex(resolvedIndex);
        }
      } catch (e) {
        console.error('SingleVideoScreen: Failed to fetch videos', e);
      } finally {
        setLoading(false);
      }
    })();
  }, [id, uploader_id, authUser?.id]);

  const handleDownload = async (item: any) => {
    try {
      try { pauseAllExcept(null); } catch (e) {}
      try { toast.show('Download started'); } catch (e) {}
      if (downloading) return;
      if (!item) { try { toast.show('No video available'); } catch (e) {} ; return; }
      setDownloading(true);

      const base = (apiClient.API_BASE_URL || '').replace(/\/$/, '');
      const uri = item.url || `${base}/video/${item.filename}`;

      try {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), 5000);
        const headResp = await fetch(uri, { method: 'HEAD', signal: ac.signal } as any);
        clearTimeout(to);
        if (!headResp.ok && headResp.status !== 200) throw new Error('Resource not available');
      } catch (err) {}

      const filename = item.filename || `video_${Date.now()}.mp4`;
      const baseDir = (FileSystem as any).cacheDirectory ?? (FileSystem as any).documentDirectory ?? '';
      let dl: any = null;
      if (!baseDir) {
        try { console.warn('download fallback: no baseDir available', { baseDir }); } catch (e) {}
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

        if (Sharing && typeof Sharing.shareAsync === 'function') {
          try { await Sharing.shareAsync(uri); } catch (e) {}
          try { toast.show('Download complete (shared)'); } catch (e) {}
          return;
        }

        throw new Error('Unable to access file system directories');
      } else {
        const dest = baseDir + filename;
        dl = await FileSystem.downloadAsync(uri, dest);
      }

      if (!MediaLibrary || typeof MediaLibrary.requestPermissionsAsync !== 'function') {
        if (Sharing && typeof Sharing.shareAsync === 'function') await Sharing.shareAsync(dl.uri);
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
            if (Sharing && typeof Sharing.shareAsync === 'function') await Sharing.shareAsync(dl.uri);
          }
          try { toast.show('Download complete'); } catch (e) {}
        } else {
          if (Sharing && typeof Sharing.shareAsync === 'function') await Sharing.shareAsync(dl.uri);
          try { toast.show('Download complete'); } catch (e) {}
        }
      } catch (err) {
        if (Sharing && typeof Sharing.shareAsync === 'function') await Sharing.shareAsync(dl.uri);
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
        <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 12 }}>
          <Text style={{ color: '#1e90ff' }}>Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <FlatList
      ref={flatListRef}
      data={videos}
      extraData={videos}
      keyExtractor={v => String(v.id)}
      renderItem={({ item, index }) => (
        <VideoDetailItem
          item={item}
          isFocused={index === currentIndex}
          containerHeight={containerHeight}
          onDownload={handleDownload}
          onCommentsUpdated={handleCommentsUpdated}
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
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'black', position: 'relative' },
  iconButton: { marginBottom: 12, alignItems: 'center' },
  iconShadow: { shadowColor: 'black', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.6, shadowRadius: 4, elevation: 6 },
  bottomOverlay: { position: 'absolute', left: 15, bottom: 100, width: '75%', zIndex: 99, right: 80, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'flex-start' },
  uploader: { color: 'white', fontWeight: '700', marginBottom: 6 },
  description: { color: 'white', marginTop: 4 },
  profilePic: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#666', marginRight: 10 },
});
