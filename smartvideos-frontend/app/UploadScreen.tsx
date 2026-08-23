import React, { useState, useRef } from 'react';
import { Platform, StyleSheet, TextInput, View, Text, ActivityIndicator, TouchableOpacity, Animated } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useRouter } from 'expo-router';
import { Video } from 'expo-av';
import MaskedView from '@react-native-masked-view/masked-view';
import { Ionicons } from '@expo/vector-icons';

import apiClient, { getToken } from './lib/api';
import LoadingOverlay from './components/LoadingOverlay';
import { useToast } from './components/Toast';

export default function UploadScreen() {
  const [description, setDescription] = useState('');
  const [filesList, setFilesList] = useState<any[]>([]); 
  const [loading, setLoading] = useState(false);
  const [currentVideoIndex, setCurrentVideoIndex] = useState<number>(0); 
  const [progress, setProgress] = useState<number | null>(null);
  
  const router = useRouter();
  const videoRef = useRef<Video | null>(null);
  const fillAnim = useRef(new Animated.Value(0)).current; 
  const toast = useToast();

  async function pickFile() {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        toast.show('Permission required: media library access is needed');
        return;
      }

      const imgRes = await ImagePicker.launchImageLibraryAsync({ 
        mediaTypes: ImagePicker.MediaTypeOptions.Videos,
        allowsMultipleSelection: true, 
        selectionLimit: 5,             
      });

      if (!imgRes.canceled && imgRes.assets && imgRes.assets.length > 0) {
        setFilesList(imgRes.assets); 
        setCurrentVideoIndex(0);     
        return;
      }

      const res = await DocumentPicker.getDocumentAsync({ type: 'video/*', multiple: true });
      if ('uri' in res && res.uri) {
        const asset = { uri: res.uri, name: (res as any).name, mimeType: (res as any).mimeType };
        setFilesList([asset]);
        setCurrentVideoIndex(0);
      }
    } catch (e: any) {
      console.log('PICK FILE ERROR', e);
      toast.show('File pick error: ' + (e?.message || String(e)));
    }
  }

  async function handleUpload() {
    if (filesList.length === 0) return toast.show('No files selected');
    
    setLoading(true);
    toast.show(`Starting upload queue for ${filesList.length} items`);

    for (let i = 0; i < filesList.length; i++) {
      setCurrentVideoIndex(i);
      try {
        await uploadFileObject(filesList[i]);
      } catch (err: any) {
        toast.show(`Failed uploading item ${i + 1}: ${err.message}`);
        setLoading(false);
        return; 
      }
    }

    toast.show('All uploads successful! Your videos will process in the feed.');
    setLoading(false);
    setProgress(null);
    
    setTimeout(() => {
      router.replace('/(tabs)');
    }, 1000);
  }

  async function uploadFileObject(fileObj: any) {
    return new Promise<void>(async (resolve, reject) => {
      try {
        setProgress(0);
        const token = await getToken();
        if (!token) return reject(new Error('Not authenticated'));

        let userId: string | null = null;
        try {
          const tokenParts = token.split('.');
          if (tokenParts.length === 3) {
            const payload = JSON.parse(atob(tokenParts[1]));
            userId = String(payload.user_id);
          }
        } catch (e) {}

        if (!userId) return reject(new Error('Could not extract user_id'));

        let uri = fileObj.uri;
        const rawName = fileObj.name || fileObj.fileName || `file_${Date.now()}.mp4`;
        const name = (rawName && rawName.split('/').pop()) || `file_${Date.now()}.mp4`;
        const type = fileObj.mimeType || fileObj.type || (name.endsWith('.mov') ? 'video/quicktime' : 'video/mp4');

        if (Platform.OS === 'android' && typeof uri === 'string' && uri.startsWith('/')) uri = 'file://' + uri;

        const form = new FormData();
        form.append('user_id', userId);
        form.append('description', description || '');
        // @ts-ignore
        form.append('file', { uri, name, type });

        const baseURL = apiClient.API_BASE_URL || 'https://smartvideos.com';
        const url = `${baseURL.replace(/\/$/, '')}/upload`;

        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.timeout = 120 * 1000;
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);

        xhr.upload.onprogress = (evt: any) => {
          if (evt && evt.lengthComputable) {
            const pct = Math.round((evt.loaded / evt.total) * 100);
            setProgress(pct);
            Animated.timing(fillAnim, { toValue: pct / 100, duration: 160, useNativeDriver: false }).start();
          }
        };

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
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Upload' }} />

      {loading && <LoadingOverlay visible={true} />}

      <View style={styles.inner}>
        {filesList.length > 0 ? (
          loading ? (
            <View style={{ alignItems: 'center', justifyContent: 'center', height: 360 }}>
              <MaskedView
                style={{ height: 240, width: 240, alignItems: 'center', justifyContent: 'center' }}
                maskElement={<View style={{ alignItems: 'center', justifyContent: 'center' }}><Ionicons name="flame" size={220} color="black" /></View>}>
                <View style={{ flex: 1, justifyContent: 'flex-end' }}>
                  <Animated.View style={{ height: fillAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }), backgroundColor: '#FF4500', width: '100%' }} />
                </View>
              </MaskedView>
              <View style={{ height: 16 }} />
              <Text style={{ color: '#000', fontWeight: 'bold' }}>
                {`Item ${currentVideoIndex + 1} of ${filesList.length}`}
              </Text>
              <Text style={{ color: '#666', marginTop: 4 }}>
                {progress != null ? `Uploading ${progress}%` : 'Uploading...'}
              </Text>
            </View>
          ) : (
            <View style={styles.previewRow}>
              <Video
                ref={videoRef}
                source={{ uri: filesList[0].uri }}
                style={styles.preview}
                resizeMode={'cover' as any}
                isLooping
                shouldPlay
                useNativeControls={false}
              />
              <View style={styles.meta}>
                <Text style={styles.label}>{`Selected (${filesList.length} videos)`}</Text>
                <Text numberOfLines={1} style={styles.fileName}>
                  {filesList[0].name || filesList[0].uri.split('/').pop()}
                </Text>
              </View>
            </View>
          )
        ) : (
          <TouchableOpacity style={styles.pickButton} onPress={pickFile}>
            <Text style={styles.pickButtonText}>Pick videos from Gallery</Text>
          </TouchableOpacity>
        )}

        <TextInput
          placeholder="Write a description..."
          placeholderTextColor="#888"
          value={description}
          onChangeText={setDescription}
          style={styles.input}
          multiline
        />

        <View style={{ height: 8 }} />

        <View style={{ flexDirection: 'row', gap: 12 }}>
          <TouchableOpacity
            style={[styles.uploadButton, (loading || filesList.length === 0) && styles.uploadButtonDisabled, { flex: 1 }]}
            onPress={handleUpload}
            disabled={loading || filesList.length === 0}
          >
            {loading ? (
              <>
                <ActivityIndicator color="#fff" />
                <Text style={styles.uploadButtonText}>{` Batch Uploading...`}</Text>
              </>
            ) : (
              <Text style={styles.uploadButtonText}>
                {`Upload ${filesList.length > 0 ? filesList.length : ''} Videos`}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#fff' },
  inner: { gap: 12 },
  previewRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  preview: { width: 160, height: 90, borderRadius: 8, backgroundColor: '#000' },
  meta: { flex: 1 },
  label: { color: '#666', fontSize: 12, marginBottom: 4 },
  fileName: { fontSize: 14, color: '#111' },
  input: { backgroundColor: '#111', color: '#fff', padding: 12, borderRadius: 10, minHeight: 80, textAlignVertical: 'top' },
  pickButton: { backgroundColor: '#222', padding: 14, borderRadius: 10, alignItems: 'center' },
  pickButtonText: { color: '#fff', fontWeight: '600' },
  uploadButton: { backgroundColor: '#FF4500', paddingVertical: 14, borderRadius: 12, alignItems: 'center', flexDirection: 'row', justifyContent: 'center' },
  uploadButtonDisabled: { opacity: 0.6 },
  uploadButtonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
