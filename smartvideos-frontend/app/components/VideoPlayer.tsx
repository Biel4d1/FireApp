import { ResizeMode, Video } from 'expo-av';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet } from 'react-native';
import { recordInteraction } from '../lib/api';
import { registerPlayer as globalRegisterPlayer } from '../lib/playerRegistry';

type Props = {
  id?: number | string;
  source: any;
  posterSource?: any;
  style?: any;
  shouldPlay?: boolean;
  isMuted?: boolean;
  progressUpdateIntervalMillis?: number;
  onPlaybackStatusUpdate?: (s: any) => void;
  onReady?: () => void;
  onPress?: () => void;
  onLongPress?: () => void;
  onTap?: () => void;
  onDoubleTap?: () => void;
  onUserToggle?: (paused: boolean) => void;
  playerRef?: React.MutableRefObject<any | null>;
};

export default function VideoPlayer({ id, source, posterSource, style, shouldPlay = false, isMuted = false, progressUpdateIntervalMillis = 500, onPlaybackStatusUpdate, onReady, onPress, onLongPress, onTap, onDoubleTap, onUserToggle, playerRef }: Props) {
  const internalRef = useRef<any>(null);
  const [userPaused, setUserPaused] = useState(false);
  const lastTapRef = useRef<number>(0);
  const tapTimerRef = useRef<any>(null);
  // playback tracking refs (ms)
  const playingStartRef = useRef<number | null>(null);
  const accumulatedMsRef = useRef<number>(0);
  const lastPingMsRef = useRef<number>(0);
  const inflightPingRef = useRef<boolean>(false);

  // expose internal ref to parent if requested
  useEffect(() => {
    if (playerRef) playerRef.current = internalRef.current;
  }, [playerRef]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      try { if (tapTimerRef.current) clearTimeout(tapTimerRef.current); } catch (e) {}
      // flush final watch time when component unmounts
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
              await recordInteraction(typeof id === 'number' ? id : Number(id), Math.max(0, Math.floor(remaining)));
            } catch (e) {}
          }
        } catch (e) {}
      })();
    };
  }, []);

  // Pause and flush when app goes to background to avoid audio continuing after resume
  useEffect(() => {
    const handler = (nextAppState: string) => {
      try {
        if (nextAppState === 'background' || nextAppState === 'inactive') {
          const p = internalRef.current;
          if (p && typeof p.pauseAsync === 'function') p.pauseAsync().catch(() => {});
          // flush watch time
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
                  await recordInteraction(typeof id === 'number' ? id : Number(id), Math.max(0, Math.floor(remaining)));
                  lastPingMsRef.current += remaining;
                } catch (e) {}
              }
            } catch (e) {}
          })();
        } else if (nextAppState === 'active') {
          // When returning to the foreground, avoid auto-playing videos unexpectedly.
          try {
            setUserPaused(true);
          } catch (e) {}
          try {
            const p = internalRef.current;
            if (p && typeof p.pauseAsync === 'function') p.pauseAsync().catch(() => {});
          } catch (e) {}
        }
      } catch (e) {}
    };

    const sub = AppState.addEventListener ? AppState.addEventListener('change', handler) : (AppState as any).addListener('change', handler);
    return () => {
      try {
        if (sub && typeof sub.remove === 'function') sub.remove();
        else if (AppState.removeEventListener) AppState.removeEventListener('change', handler as any);
      } catch (e) {}
    };
  }, []);

  // register globally so other screens can pause this player
  useEffect(() => {
    try {
      if (id != null) globalRegisterPlayer(id, internalRef);
    } catch (e) {}
    return () => { try { if (id != null) globalRegisterPlayer(id, undefined); } catch (e) {} };
  }, [id]);

  const togglePlay = useCallback(async () => {
    try {
      const p = internalRef.current;
      if (!p) return;
      
      // Get current playback status
      let isCurrentlyPlaying = false;
      try {
        if (typeof p.getStatusAsync === 'function') {
          const st = await p.getStatusAsync().catch(() => null);
          if (st && typeof st === 'object' && 'isLoaded' in st) {
            const ss = st as any;
            isCurrentlyPlaying = Boolean(ss.isPlaying || ss.shouldPlay);
          }
        }
      } catch (e) {}

      // Toggle the pause state
      const shouldBePaused = isCurrentlyPlaying;
      setUserPaused(shouldBePaused);
      try { if (typeof onUserToggle === 'function') onUserToggle(shouldBePaused); } catch (e) {}

      // Directly call pause or play on the player
      if (shouldBePaused && typeof p.pauseAsync === 'function') {
        try { 
          await p.pauseAsync(); 
        } catch (e) {}
      } else if (!shouldBePaused && typeof p.playAsync === 'function') {
        try { 
          await p.playAsync(); 
        } catch (e) {}
      }
    } catch (e) {}
  }, [onUserToggle]);

  const handlePress = useCallback(async () => {
    try {
      const now = Date.now();
      const timeSinceLastTap = now - lastTapRef.current;

      if (timeSinceLastTap < 300 && onDoubleTap) {
        // Double tap detected within 300ms - trigger onDoubleTap (like), clear timer
        try { if (tapTimerRef.current) clearTimeout(tapTimerRef.current); } catch (e) {}
        try { onDoubleTap(); } catch (e) {}
        lastTapRef.current = 0; // Reset to prevent triple-tap issues
      } else {
        // First tap - set a timer to wait for potential second tap
        lastTapRef.current = now;
        
        // Clear any existing timer
        try { if (tapTimerRef.current) clearTimeout(tapTimerRef.current); } catch (e) {}
        
        // Set new timer: if no second tap within 300ms, execute single-tap logic
        tapTimerRef.current = setTimeout(async () => {
          try {
            try { if (onTap) onTap(); } catch (e) {}
            if (onPress) {
              try { onPress(); } catch (e) {}
            }
            await togglePlay();
          } catch (e) {}
        }, 300);
      }
    } catch (e) {}
  }, [togglePlay, onPress, onTap, onDoubleTap]);

  // Reset userPaused only when the video ID changes to a different value (scrolling to a new video).
  // If user pauses the same video, the pause state persists.
  const prevIdRef = useRef<number | string | undefined>(undefined);
  useEffect(() => {
    // Only reset the manual pause state if the video ID value actually changed
    if (id !== prevIdRef.current) {
      setUserPaused(false);
      prevIdRef.current = id;
    }
  }, [id]);

  // When shouldPlay changes or source changes, update player state
  useEffect(() => {
    if (!internalRef.current) return;
    
    const updatePlayState = async () => {
      try {
        if (shouldPlay && !userPaused) {
          // Should be playing - ensure player starts
          if (typeof internalRef.current.playAsync === 'function') {
            await internalRef.current.playAsync().catch(() => {});
          }
        }
      } catch (e) {}
    };

    // Small delay to ensure video is loaded
    const timer = setTimeout(updatePlayState, 100);
    return () => clearTimeout(timer);
  }, [shouldPlay, userPaused, source]);

  // When isMuted changes, ensure we don't show pause overlay if we're supposed to be playing
  useEffect(() => {
    if (shouldPlay && userPaused) {
      setUserPaused(false);
    }
  }, [isMuted]);

  // When shouldPlay becomes true (video scrolled back into view), reset to beginning and start playing
  useEffect(() => {
    if (shouldPlay && internalRef.current) {
      (async () => {
        try {
          // Reset pause state
          setUserPaused(false);
          
          // Seek to beginning
          if (typeof internalRef.current.setPositionAsync === 'function') {
            await internalRef.current.setPositionAsync(0).catch(() => {});
          }
          
          // Start playback
          if (typeof internalRef.current.playAsync === 'function') {
            await internalRef.current.playAsync().catch(() => {});
          }
        } catch (e) {}
      })();
    }
  }, [shouldPlay]);

  return (
    <Pressable style={[styles.container, style]} onPress={handlePress} onLongPress={onLongPress ?? undefined}>
      <Video
        ref={internalRef}
        style={StyleSheet.absoluteFill}
        resizeMode={ResizeMode.CONTAIN}
        isLooping
        shouldPlay={shouldPlay && !userPaused}
        isMuted={isMuted}
        posterSource={posterSource}
        progressUpdateIntervalMillis={progressUpdateIntervalMillis}
        source={source}
        onPlaybackStatusUpdate={s => {
          try {
            // internal tracking: start/stop timer and ping backend every 5s
            const now = Date.now();
            let isPlaying = false;
            if (s && typeof s === 'object' && 'isLoaded' in s) {
              const ss = s as any;
              isPlaying = Boolean(ss.isPlaying || ss.shouldPlay);
            }

            if (isPlaying) {
              if (playingStartRef.current == null) playingStartRef.current = now;
            } else {
              if (playingStartRef.current != null) {
                accumulatedMsRef.current += now - playingStartRef.current;
                playingStartRef.current = null;
              }
            }

            const currentTotal = accumulatedMsRef.current + (playingStartRef.current != null ? (now - playingStartRef.current) : 0);
            const delta = currentTotal - lastPingMsRef.current;
            if (delta >= 5000 && !inflightPingRef.current) {
              const toSend = Math.floor(delta / 5000) * 5000;
              inflightPingRef.current = true;
              (async () => {
                try {
                  await recordInteraction(typeof id === 'number' ? id : Number(id), toSend);
                  lastPingMsRef.current += toSend;
                } catch (e) {
                  // ignore network/token errors
                } finally {
                  inflightPingRef.current = false;
                }
              })();
            }
          } catch (e) {}

          try { if (onPlaybackStatusUpdate) onPlaybackStatusUpdate(s); } catch (e) {}
        }}
        onLoad={() => { 
          try { 
            if (shouldPlay && !userPaused && internalRef.current) {
              if (typeof internalRef.current.playAsync === 'function') {
                internalRef.current.playAsync().catch(() => {});
              }
            }
            if (onReady) onReady(); 
          } catch (e) {} 
        }}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({ 
  container: { width: '100%', height: '100%', backgroundColor: '#000' }
});