import React, { useState, useContext } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator, ScrollView, Platform, KeyboardAvoidingView, TouchableWithoutFeedback, Keyboard } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';

import apiClient, { getToken, decodeTokenUserId } from './lib/api';
import { AuthContext } from './lib/auth';
import { useToast } from './components/Toast';

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    padding: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 40,
    marginBottom: 20,
  },
  title: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  previewContainer: {
    flexDirection: 'row',
    marginBottom: 20,
  },
  card: {
    width: 100,
    height: 150,
    borderRadius: 8,
    marginRight: 10,
    backgroundColor: '#1c1c1e',
    overflow: 'hidden',
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  activeCard: {
    borderWidth: 2,
    borderColor: '#FF4500',
  },
  badge: {
    position: 'absolute',
    top: 6,
    right: 6,
    backgroundColor: '#FF4500',
    borderRadius: 10,
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  badgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  actionButton: {
    width: 100,
    height: 150,
    borderRadius: 8,
    backgroundColor: '#1c1c1e',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  actionText: {
    color: '#aaa',
    fontSize: 12,
    marginTop: 6,
  },
  inputContainer: {
    marginTop: 10,
  },
  sectionHeader: {
    color: '#8e8e93',
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  darkInput: {
    backgroundColor: '#1c1c1e',
    color: '#fff',
    borderRadius: 8,
    padding: 12,
    height: 100,
    textAlignVertical: 'top',
  },
  charCount: {
    color: '#545456',
    fontSize: 12,
    textAlign: 'right',
    marginTop: 4,
  },
  publishButton: {
    backgroundColor: '#FF3B30',
    borderRadius: 24,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 30,
  },
  disabledButton: {
    opacity: 0.5,
  },
  publishText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
});

export default function UploadScreen() {
  const router = useRouter();
  const toast = useToast();
  const { user } = useContext(AuthContext);

  const [filesList, setFilesList] = useState<any[]>([]);
  const [descriptions, setDescriptions] = useState<{ [key: number]: string }>({});
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [uploading, setUploading] = useState(false);

  const pickMedia = async () => {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Videos,
        allowsMultipleSelection: true,
        quality: 1,
      });

      if (!res.canceled && res.assets && res.assets.length > 0) {
        setFilesList((prev) => [...prev, ...res.assets]);
      }
    } catch (e: any) {
      toast.show('Failed to pick videos');
    }
  };

  const recordVideo = async () => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        toast.show('Camera permission is required');
        return;
      }
      const res = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Videos,
        quality: 1,
      });

      if (!res.canceled && res.assets && res.assets.length > 0) {
        setFilesList((prev) => [...prev, ...res.assets]);
      }
    } catch (e: any) {
      toast.show('Failed to record video');
    }
  };

  const uploadFileObject = async (asset: any, idx: number) => {
    return new Promise<void>(async (resolve, reject) => {
      try {
        const token = await getToken();
        if (!token) return reject(new Error('Not authenticated'));

        let userId = user?.id || decodeTokenUserId(token || undefined);
        if (!userId) return reject(new Error('Could not extract user_id'));

        let uri = asset.uri;
        const rawName = asset.name || asset.fileName || `video_${Date.now()}.mp4`;
        const filename = rawName.split('/').pop() || `video_${Date.now()}.mp4`;
        const type = asset.mimeType || asset.type || (filename.endsWith('.mov') ? 'video/quicktime' : 'video/mp4');

        if (Platform.OS === 'android' && typeof uri === 'string' && uri.startsWith('/')) {
          uri = 'file://' + uri;
        }

        const form = new FormData();
        form.append('user_id', String(userId));
        form.append('description', descriptions[idx] || '');
        form.append('file', {
          uri,
          name: filename,
          type,
        } as any);

        const baseURL = (apiClient.API_BASE_URL || '').replace(/\/$/, '');
        const url = `${baseURL}/upload`;

        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.timeout = 120 * 1000;
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);

        xhr.onload = () => {
          if (xhr.status === 201 || xhr.status === 200) {
            resolve();
          } else {
            reject(new Error(xhr.responseText || `HTTP ${xhr.status}`));
          }
        };

        xhr.onerror = () => reject(new Error('Network Error'));
        xhr.ontimeout = () => reject(new Error('Upload timed out'));
        xhr.send(form as any);
      } catch (err) {
        reject(err);
      }
    });
  };

  const handlePublish = async () => {
    if (filesList.length === 0 || uploading) return;
    setUploading(true);
    toast.show(`Starting upload queue for ${filesList.length} items`);

    try {
      for (let idx = 0; idx < filesList.length; idx++) {
        await uploadFileObject(filesList[idx], idx);
      }
      toast.show('All videos uploaded successfully');
      router.back();
    } catch (e: any) {
      toast.show(`Failed uploading: ${e?.message || 'Error'}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <KeyboardAvoidingView 
      style={{ flex: 1, backgroundColor: '#000' }} 
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
    >
      <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
        <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="close" size={28} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>
          {filesList.length > 0 ? `MEDIA SELECTED (${filesList.length})` : 'NEW POST'}
        </Text>
        <View style={{ width: 28 }} />
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.previewContainer}>
        {filesList.map((file, idx) => (
          <TouchableOpacity
            key={idx}
            onPress={() => setSelectedIndex(idx)}
            style={[styles.card, selectedIndex === idx && styles.activeCard]}
          >
            <Ionicons name="videocam" size={32} color="#FF4500" />
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{idx + 1}</Text>
            </View>
          </TouchableOpacity>
        ))}

        <TouchableOpacity onPress={recordVideo} style={styles.actionButton}>
          <Ionicons name="camera" size={32} color="#FF4500" />
          <Text style={styles.actionText}>Record</Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={pickMedia} style={styles.actionButton}>
          <Ionicons name="add" size={32} color="#aaa" />
          <Text style={styles.actionText}>Gallery</Text>
        </TouchableOpacity>
      </ScrollView>

      {filesList.length > 0 && (
        <View style={styles.inputContainer}>
          <Text style={styles.sectionHeader}>{`CAPTION FOR VIDEO #${selectedIndex + 1}`}</Text>
          <TextInput
            placeholder={`Describe video #${selectedIndex + 1}, add hashtags or vibes...`}
            placeholderTextColor="#545456"
            value={descriptions[selectedIndex] || ''}
            onChangeText={(text) => setDescriptions((prev) => ({ ...prev, [selectedIndex]: text }))}
            style={styles.darkInput}
            multiline
            maxLength={150}
          />
          <Text style={styles.charCount}>{`${(descriptions[selectedIndex] || '').length}/150`}</Text>
        </View>
      )}

      <TouchableOpacity
        onPress={handlePublish}
        disabled={filesList.length === 0 || uploading}
        style={[styles.publishButton, (filesList.length === 0 || uploading) && styles.disabledButton]}
      >
        {uploading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.publishText}>
            {filesList.length > 1 ? `Publish ${filesList.length} Videos` : 'Publish'}
          </Text>
        )}
      </TouchableOpacity>
        </View>
      </TouchableWithoutFeedback>
    </KeyboardAvoidingView>
  );
}
