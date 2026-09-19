import React from 'react';
import { Text, TextProps, StyleSheet } from 'react-native';
import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';

export default function GradientText({ children, style, ...rest }: TextProps & { children: React.ReactNode }) {
  return (
    <MaskedView maskElement={<Text style={[style, styles.maskText]}>{children}</Text>}>
      <LinearGradient colors={['#FF4500', '#FF0000']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
        <Text style={[style, { opacity: 0 }]} {...rest}>{children}</Text>
      </LinearGradient>
    </MaskedView>
  );
}

const styles = StyleSheet.create({
  maskText: { backgroundColor: 'transparent' },
});
