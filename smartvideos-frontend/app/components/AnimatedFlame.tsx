import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export default function AnimatedFlame({ animating = false, size = 36 }: { animating?: boolean; size?: number }) {
  const scale = useRef(new Animated.Value(1)).current;
  const rotate = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!animating) {
      scale.setValue(1);
      rotate.setValue(0);
      return;
    }

    const scaleAnim = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.15, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(scale, { toValue: 1.0, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: true })
      ])
    );

    const rotateAnim = Animated.loop(
      Animated.timing(rotate, { toValue: 1, duration: 2000, easing: Easing.linear, useNativeDriver: true })
    );

    scaleAnim.start();
    rotateAnim.start();

    return () => {
      scaleAnim.stop();
      rotateAnim.stop();
      scale.setValue(1);
      rotate.setValue(0);
    };
  }, [animating, rotate, scale]);

  const rotateInterp = rotate.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <Animated.View style={[styles.container, { transform: [{ scale }, { rotate: rotateInterp }] }]}>
      <Ionicons name="flame" size={size} color="#FF4500" />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', justifyContent: 'center' },
});
