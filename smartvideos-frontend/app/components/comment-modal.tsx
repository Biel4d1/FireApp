import React, { useEffect, useState, useContext } from 'react';
import {
  Modal,
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';

import { AuthContext } from '../lib/auth';
import { useVideoStore } from '../lib/videoStore';
import { useToast } from '../components/Toast';

import { getToken, decodeTokenUserId, deleteComment, reportUser } from '../lib/api';
import apiClient from '../lib/api';
import ReportModal from './ReportModal';
import ConfirmModal from './ConfirmModal';

type Props = {
  visible: boolean;
  videoId: number | null;
  onClose: () => void;
  onCommentsUpdated?: (videoId: number | null, newCount: number) => void;
};

export default function CommentModal({ visible, videoId, onClose, onCommentsUpdated }: Props) {
  const { user: authUser } = useContext(AuthContext);
  const videoStore = useVideoStore();
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [comments, setComments] = useState<Array<any>>([]);
  const [text, setText] = useState('');
  const [reportVisible, setReportVisible] = useState(false);
  const [reportInitialText, setReportInitialText] = useState<string | undefined>(undefined);
  const [reportTargetUserId, setReportTargetUserId] = useState<number | null>(null);
  const [reportCommentText, setReportCommentText] = useState<string | undefined>(undefined);
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null);

  useEffect(() => {
    if (!visible || !videoId) return;
    let mounted = true;
    (async () => {
      try {
        setLoading(true);
        const token = await getToken();
        const client = apiClient.getApiClient(token);
        const resp = await client.get(`/get_comments/${videoId}`);
        if (mounted) setComments(resp.data?.comments || []);
      } catch (e: any) {
        try { toast.show(e?.response?.data?.error || 'Failed to load comments'); } catch (e2) {}
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [visible, videoId]);

  async function handleSend() {
    if (!text.trim() || !videoId) return;
    const commentText = text.trim();
    setText('');
    // optimistic update - mark as local so we can delete locally before server round-trip
    const tmpId = `tmp-${Date.now()}`;
    setComments(c => [{ id: tmpId, comment_text: commentText, username: authUser?.username || 'You', user_id: authUser?.id, profile_pic_url: authUser?.profile_pic_url, __isLocal: true }, ...c]);

    try {
      const token = await getToken();
      const userId = decodeTokenUserId(token || undefined);
      const client = apiClient.getApiClient(token);
      // Ensure add_comment succeeds before proceeding
      const addResp = await client.post('/add_comment', { video_id: Number(videoId), comment_text: commentText });
      
      // re-fetch comments to get authoritative list and count
      try {
        const token = await getToken();
        const client = apiClient.getApiClient(token);
        const resp = await client.get(`/get_comments/${videoId}`);
        const list = resp.data?.comments || [];
        setComments(list);
        // Only notify parent after confirmed server success
        onCommentsUpdated && onCommentsUpdated(videoId, list.length);
      } catch (e) {
        // if re-fetch fails, still notify parent with optimistic count
        // This ensures local state is updated even if the refetch fails
        const newCount = (comments?.length || 0) + 1;
        onCommentsUpdated && onCommentsUpdated(videoId, newCount);
      }
    } catch (e: any) {
      // API call failed - rollback optimistic UI update
      try {
        const token = await getToken();
        const client = apiClient.getApiClient(token);
        const resp = await client.get(`/get_comments/${videoId}`);
        const list = resp.data?.comments || [];
        setComments(list);
      } catch (e2) {
        // If we can't even fetch the comments list, just keep what's displayed
      }
      try { toast.show(e?.response?.data?.error || 'Failed to post comment'); } catch (e2) {}
    }
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.select({ ios: 'padding', android: 'height' })} style={styles.container} keyboardVerticalOffset={0}>
        <SafeAreaView style={styles.container}>
          <View style={styles.header}>
            <Text style={styles.title}>Comments</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <Text style={{ color: '#fff' }}>Close</Text>
            </TouchableOpacity>
          </View>

          {loading ? (
            <ActivityIndicator style={{ marginTop: 24 }} />
          ) : (
            <FlatList
              data={comments}
              keyExtractor={(i) => String(i.id)}
              contentContainerStyle={{ padding: 12 }}
              renderItem={({ item }) => {
                // determine avatar: if comment belongs to current user, use authUser.profile_pic_url
                let avatarUri: string | null = null;
                if (authUser && item.user_id && authUser.id === item.user_id && authUser.profile_pic_url) {
                  const raw = authUser.profile_pic_url;
                  const base = (apiClient.API_BASE_URL || '').replace(/\/$/, '');
                  const absolute = String(raw).startsWith('http');
                  const url = absolute ? raw : `${base}/${raw}`;
                  avatarUri = url;
                } else if (item.profile_pic_url) {
                  const raw = item.profile_pic_url;
                  // Handle absolute vs relative URLs
                  if (String(raw).startsWith('http')) {
                    avatarUri = raw;
                  } else {
                    const base = (apiClient.API_BASE_URL || '').replace(/\/$/, '');
                    avatarUri = `${base}/${raw}`;
                  }
                }

                return (
                  <TouchableOpacity
                    style={styles.commentRow}
                    activeOpacity={0.8}
                    onLongPress={() => {
                      try {
                        // allow delete only if the current user is the comment owner
                        const isCommentOwner = authUser && item.user_id && authUser.id === item.user_id;
                        if (isCommentOwner) {
                          setDeleteTargetId(item.id);
                          setConfirmVisible(true);
                          return;
                        }

                        // Not the owner: open report modal to report this comment's user + include comment text
                        try {
                          setReportTargetUserId(item.user_id ?? null);
                          setReportCommentText(item.comment_text ?? item.content ?? item.text ?? undefined);
                          setReportInitialText(undefined);
                          setReportVisible(true);
                        } catch (e) {}
                      } catch (e) {}
                    }}
                  >
                    {avatarUri ? (
                      <ExpoImage source={{ uri: avatarUri }} style={styles.avatar} contentFit="cover" cachePolicy="disk" onError={() => {
                        console.warn('[Comments] Failed to load avatar:', avatarUri);
                      }} />
                    ) : (
                      <View style={[styles.avatar, { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.12)' }]}>
                        <Ionicons name="person-circle" size={24} color="white" />
                      </View>
                    )}
                    <View style={{ marginLeft: 12, flex: 1 }}>
                      <Text style={styles.username}>{item.username || item.user_name || `User ${item.user_id || ''}`}</Text>
                      <Text style={styles.commentText}>{item.comment_text ?? item.content ?? item.text}</Text>
                    </View>
                  </TouchableOpacity>
                );
              }}
            />
          )}

          <View style={styles.inputRow}>
            <TextInput
              placeholder="Add a comment"
              placeholderTextColor="#888"
              value={text}
              onChangeText={setText}
              style={styles.input}
            />
            <TouchableOpacity onPress={handleSend} style={styles.sendButton}>
              <Text style={{ color: '#fff' }}>Send</Text>
            </TouchableOpacity>
          </View>
          {reportVisible && (
            <ReportModal visible={reportVisible} initialText={reportInitialText} title="Report comment" message="Please describe why you're reporting this comment (optional):" onCancel={() => { setReportVisible(false); setReportTargetUserId(null); setReportCommentText(undefined); }} onSubmit={async (rtext) => {
              try {
                setReportVisible(false);
                const target = reportTargetUserId;
                const commentBody = reportCommentText;
                setReportTargetUserId(null);
                setReportCommentText(undefined);
                if (!target) return;
                const reason = (rtext && rtext.length > 0) ? `${rtext} -- comment: ${commentBody ?? ''}` : `Reported comment: ${commentBody ?? ''}`;
                await reportUser(target, reason);
                try { toast.show('Reported user/comment'); } catch (e) {}
              } catch (e: any) {
                try { toast.show(e?.response?.data?.error || 'Report failed'); } catch (e) {}
              }
            }} />
          )}

          <ConfirmModal visible={confirmVisible} title="Delete comment" message="Are you sure you want to delete this comment?" onCancel={() => { setConfirmVisible(false); setDeleteTargetId(null); }} onConfirm={async () => {
            if (!deleteTargetId) { setConfirmVisible(false); return; }
            setConfirmVisible(false);
            try {
              const targetId = deleteTargetId;
              // find the comment in the current list
              const targetComment = (comments || []).find((c: any) => String(c.id) === String(targetId));
              // If this is a local-only optimistic comment, just remove it locally
              if (targetComment && (targetComment.__isLocal || String(targetId).startsWith('tmp-'))) {
                const newList = (comments || []).filter((c: any) => String(c.id) !== String(targetId));
                setComments(newList);
                try { toast.show('Comment removed'); } catch (e) {}
                onCommentsUpdated && onCommentsUpdated(videoId, newList.length);
              } else {
                // Persisted comment: call API to delete
                await deleteComment(Number(targetId));
                const newList = (comments || []).filter((c: any) => String(c.id) !== String(targetId));
                setComments(newList);
                try { toast.show('Comment deleted'); } catch (e) {}
                onCommentsUpdated && onCommentsUpdated(videoId, newList.length);
              }
            } catch (e: any) {
              try { toast.show(e?.response?.data?.error || 'Failed to delete comment'); } catch (e2) {}
            }
            setDeleteTargetId(null);
          }} />
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 12, borderBottomWidth: 0.5, borderBottomColor: '#222' },
  title: { color: '#fff', fontSize: 18, fontWeight: '700' },
  closeButton: { padding: 8 },
  commentRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12 },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#444' },
  username: { color: '#fff', fontWeight: '700' },
  commentText: { color: 'white', fontSize: 15, marginTop: 4 },
  inputRow: { flexDirection: 'row', padding: 12, borderTopWidth: 0.5, borderTopColor: '#222', alignItems: 'center' },
  input: { flex: 1, backgroundColor: '#111', color: '#fff', padding: 10, borderRadius: 8, marginRight: 8 },
  sendButton: { backgroundColor: '#FF4500', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
});
