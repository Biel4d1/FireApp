import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export default function LoadingOverlay({ visible = true }: { visible?: boolean }) {
  const scale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.2, duration: 600, useNativeDriver: true }),
        Animated.timing(scale, { toValue: 1.0, duration: 600, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [scale]);

  if (!visible) return null;

  return (
    <View style={[styles.backdrop, { position: 'absolute' }]} pointerEvents="none">
      <Animated.View style={[styles.iconWrap, { transform: [{ scale }] }]}> 
        <Ionicons name="flame" size={72} color="#FF4500" />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'black', alignItems: 'center', justifyContent: 'center', zIndex: 1 },
  iconWrap: { alignItems: 'center', justifyContent: 'center' },
});
