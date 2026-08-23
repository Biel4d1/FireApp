import React, { useState, useEffect, useContext, useRef, useCallback } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ActivityIndicator,
  Dimensions,
  Platform,
  TextInput,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { getToken, toggleLike, decodeTokenUserId, searchContent } from '../lib/api';
import apiClient from '../lib/api';
import { AuthContext } from '../lib/auth';
import { useVideoStore } from '../lib/videoStore';
import { useToast } from '../components/Toast';

function VideoCard({
  item,
  itemWidth,
  itemHeight,
  onToggleLike,
  onNavigate,
}: {
  item: any;
  itemWidth: number;
  itemHeight: number;
  onToggleLike: (videoId: number) => void;
  onNavigate: (item: any) => void;
}) {
  const videoStore = useVideoStore();
  const base = (apiClient.API_BASE_URL || '').replace(/\/$/, '');
  const stored = videoStore.getVideo(item.id) || {};
  const displayLikes = stored?.likes_count ?? item.likes_count ?? 0;
  const serverComments = item?.comments_count ?? (item?.comments ?? item?.comment_count ?? 0);
  const displayComments = Math.max(Number(stored?.comments_count ?? 0), Number(serverComments ?? 0));
  const displayLiked = Boolean(item?.is_liked ?? item?.liked ?? stored?.is_liked ?? stored?.liked);

  const getThumbnailUri = () => {
    if (item.thumbnail) {
      return String(item.thumbnail).startsWith('http')
        ? item.thumbnail
        : `${base}/${String(item.thumbnail).replace(/^\//, '')}`;
    }
    const rawUrl = item.url ? String(item.url).replace(/^\//, '') : `video/${item.filename}`;
    return rawUrl.startsWith('http') ? rawUrl : `${base}/${rawUrl}`;
  };

  const thumbnailUri = getThumbnailUri();

  const handleLikePress = useCallback(
    (e: any) => {
      e?.stopPropagation && e.stopPropagation();
      onToggleLike(item.id);
    },
    [item.id, onToggleLike]
  );

  const handleCardPress = useCallback(
    (e: any) => {
      e?.stopPropagation && e.stopPropagation();
      onNavigate(item);
    },
    [item, onNavigate]
  );

  return (
    <TouchableOpacity
      style={[styles.videoCard, { width: itemWidth, height: itemHeight }]}
      activeOpacity={0.9}
      onPress={handleCardPress}
    >
      <ExpoImage
        source={{ uri: thumbnailUri }}
        style={StyleSheet.absoluteFillObject}
        contentFit="cover"
        cachePolicy="disk"
      />
      
      <View style={styles.playIconOverlay}>
        <Ionicons name="play-circle" size={44} color="rgba(255, 255, 255, 0.85)" />
      </View>

      <View style={styles.overlay}>
        <View style={styles.topRight}>
          <TouchableOpacity
            style={styles.likeButton}
            onPressIn={(e: any) => { try { e?.stopPropagation && e.stopPropagation(); } catch (err) {} }}
            onPress={handleLikePress}
          >
            <Ionicons
              name="heart"
              size={24}
              color={displayLiked ? '#ff1744' : 'white'}
              style={{
                textShadowColor: 'black',
                textShadowOffset: { width: 1, height: 1 },
                textShadowRadius: 2,
              }}
            />
          </TouchableOpacity>
        </View>

        <View style={styles.bottomInfo}>
          <View style={styles.statsRow}>
            <View style={styles.stat}>
              <Ionicons name="flame" size={14} color="#FF4500" />
              <Text style={styles.statText}>{displayLikes || 0}</Text>
            </View>
            <View style={styles.stat}>
              <Ionicons name="chatbubble-outline" size={14} color="white" />
              <Text style={styles.statText}>{displayComments || 0}</Text>
            </View>
          </View>
          <Text style={styles.username} numberOfLines={1}>
            @{item.username || 'Unknown'}
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

export default function ExploreScreen() {
  const { user: authUser } = useContext(AuthContext);
  const router = useRouter();
  const videoStore = useVideoStore();
  const toast = useToast();
  const [videos, setVideos] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[] | null>(null);

  const screenWidth = Dimensions.get('window').width;
  const itemWidth = (screenWidth - 16) / 2;
  const itemHeight = itemWidth * 1.3;

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    try {
      setLoading(true);
      const res = await searchContent(searchQuery.trim());
      let combined: any[] = [];
      if (Array.isArray(res)) {
        combined = res;
      } else if (res && typeof res === 'object') {
        if (Array.isArray(res.videos)) combined = [...res.videos];
        if (Array.isArray(res.results)) combined = [...combined, ...res.results];
        if (Array.isArray(res.users) && res.users.length > 0) {
          const userMatched = videos.filter((v) =>
            res.users.some((u: any) => u.username?.toLowerCase() === v.username?.toLowerCase())
          );
          combined = [...combined, ...userMatched];
        }
      }
      setSearchResults(combined);
    } catch (e: any) {
      try { toast.show('Search failed'); } catch (err) {}
    } finally {
      setLoading(false);
    }
  };

  const fetchVideos = useCallback(async () => {
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
        return {
          ...v,
          is_liked: typeof v.is_liked === 'boolean' ? v.is_liked : (storedVideo?.is_liked ?? false),
          liked: typeof v.is_liked === 'boolean' ? v.is_liked : (storedVideo?.is_liked ?? false),
          likes_count: storedVideo?.likes_count ?? v.likes_count,
          comments_count: Math.max(Number(storedVideo?.comments_count ?? 0), Number((v.comments_count ?? v.comments ?? v.comment_count ?? 0) ?? 0)),
          dislikes_count: storedVideo?.dislikes_count ?? v.dislikes_count,
          is_disliked: typeof v.is_disliked === 'boolean' ? v.is_disliked : (storedVideo?.is_disliked ?? false),
        };
      });

      setVideos(normalized);
      try { videoStore.setVideos(normalized); } catch (e) {}
    } catch (e) {
      console.error('Explore: Failed to fetch videos', e);
      try { toast.show('Failed to load videos'); } catch (err) {}
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [videoStore, toast, authUser?.id]);

  useEffect(() => {
    fetchVideos();
  }, [fetchVideos]);

  const handleToggleLike = useCallback(
    async (videoId: number) => {
      try {
        let token = await getToken();
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
            const newLikes =
              typeof v.likes_count === 'number'
                ? Math.max(0, v.likes_count + (newLiked ? 1 : -1))
                : newLiked
                ? 1
                : 0;
            const updated = {
              ...v,
              likes_count: newLikes,
              liked: newLiked,
              is_liked: newLiked,
            };
            try {
              videoStore.updateVideo(videoId, {
                likes_count: updated.likes_count,
                is_liked: updated.is_liked,
                liked: updated.liked,
              });
            } catch (e) {}
            return updated;
          })
        );

        const resp = await toggleLike(videoId as any as number);
        const likedNow = resp?.is_liked ?? false;
        const likes = resp?.likes_count;
        const finalDisliked = resp?.is_disliked ?? false;
        const dislikes = resp?.dislikes_count;

        setVideos((vs) =>
          vs.map((v) => {
            if (v.id !== videoId) return v;
            return {
              ...v,
              likes_count: typeof likes === 'number' ? Math.max(0, likes) : v.likes_count,
              dislikes_count: typeof dislikes === 'number' ? Math.max(0, dislikes) : v.dislikes_count,
              liked: Boolean(likedNow),
              is_liked: Boolean(likedNow),
              is_disliked: typeof finalDisliked === 'boolean' ? finalDisliked : Boolean(v.is_disliked),
            };
          })
        );

        try {
          videoStore.updateVideo(videoId, {
            likes_count: typeof likes === 'number' ? likes : undefined,
            is_liked: Boolean(likedNow),
            is_disliked: typeof finalDisliked === 'boolean' ? finalDisliked : undefined,
            dislikes_count: typeof dislikes === 'number' ? dislikes : undefined,
          });
        } catch (e) {}
      } catch (e) {
        console.error('Explore: Toggle like failed', e);
      }
    },
    [toast, videoStore]
  );

  const handleNavigate = useCallback(
    (item: any) => {
      router.push({
        pathname: '/video/[id]',
        params: {
          id: String(item.id),
          username: item.username,
          profile_pic_url: item.profile_pic_url,
        },
      });
    },
    [router]
  );

  const renderVideoItem = useCallback(
    ({ item }: { item: any }) => (
      <VideoCard
        item={item}
        itemWidth={itemWidth}
        itemHeight={itemHeight}
        onToggleLike={handleToggleLike}
        onNavigate={handleNavigate}
      />
    ),
    [itemWidth, itemHeight, handleToggleLike, handleNavigate]
  );

  const handleRefresh = useCallback(() => {
    try { toast.show('Refreshing'); } catch (e) {}
    setRefreshing(true);
    fetchVideos();
  }, [toast, fetchVideos]);

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centerContent}>
          <ActivityIndicator size="large" color="#FF4500" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#111', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
          <Ionicons name="search" size={20} color="#888" style={{ marginRight: 8 }} />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            onSubmitEditing={handleSearch}
            placeholder="Search AI tags, captions, users..."
            placeholderTextColor="#666"
            style={{ flex: 1, color: 'white', height: 40 }}
            returnKeyType="search"
          />
          {Boolean(searchQuery) && (
            <TouchableOpacity onPress={() => { setSearchQuery(''); setSearchResults(null); }}>
              <Ionicons name="close-circle" size={18} color="#888" />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <FlatList
        data={searchResults !== null ? searchResults : videos}
        extraData={searchResults !== null ? searchResults : videos}
        keyExtractor={(v) => String(v.id)}
        renderItem={renderVideoItem}
        numColumns={2}
        columnWrapperStyle={styles.columnWrapper}
        contentContainerStyle={styles.contentContainer}
        onRefresh={handleRefresh}
        refreshing={refreshing}
        initialNumToRender={6}
        maxToRenderPerBatch={10}
        windowSize={5}
        removeClippedSubviews={Platform.OS === 'android'}
        ListEmptyComponent={() => (
          <View style={styles.centerContent}>
            <Text style={styles.emptyText}>No videos found</Text>
          </View>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#000',
    borderBottomWidth: 1,
    borderBottomColor: '#222',
  },
  contentContainer: {
    padding: 8,
  },
  columnWrapper: {
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  videoCard: {
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#111',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-between',
    paddingTop: 8,
    paddingRight: 8,
    paddingBottom: 8,
  },
  topRight: {
    alignSelf: 'flex-end',
  },
  likeButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playIconOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.15)',
  },
  bottomInfo: {
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 8,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 6,
  },
  stat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  statText: {
    color: 'white',
    fontSize: 12,
    fontWeight: '600',
  },
  username: {
    fontSize: 12,
    fontWeight: '600',
    color: 'white',
  },
  centerContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    color: '#888',
    fontSize: 16,
  },
});
