import React, { useRef, useState } from 'react';
import { View, StyleSheet, Pressable } from 'react-native';
import { Video, ResizeMode, AVPlaybackStatus } from 'expo-av';

interface VideoPlayerProps {
  video: {
    id: number;
    url: string;
    thumbnail_url?: string;
  };
  shouldPlay: boolean;
  onProgressUpdate?: (pos: number, dur: number) => void;
  onToggleControls?: () => void;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({ video, shouldPlay, onProgressUpdate, onToggleControls }) => {
  const videoRef = useRef<Video>(null);
  const [userPaused, setUserPaused] = useState(false);

  const togglePlay = () => {
    onToggleControls?.();
    setUserPaused(!userPaused);
  };

  return (
    <View style={styles.container}>
      <Pressable style={styles.touchArea} onPress={togglePlay} pointerEvents="box-none">
        <Video
          ref={videoRef}
          source={{ uri: video.url }}
          posterSource={video.thumbnail_url ? { uri: video.thumbnail_url } : undefined}
          usePoster={true}
          posterStyle={{ resizeMode: 'cover' }}
          style={styles.video}
          resizeMode={ResizeMode.COVER}
          shouldPlay={shouldPlay && !userPaused}
          isLooping
        useNativeControls={false}={true}
          useNativeControls={false}
          progressUpdateIntervalMillis={250}
          onPlaybackStatusUpdate={(s) => { if (s.isLoaded) { onProgressUpdate?.(s.positionMillis || 0, s.durationMillis || 1); } }}
        />
      </Pressable>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  touchArea: {
    flex: 1,
  },
  video: {
    width: '100%',
    height: '100%',
  },
});
