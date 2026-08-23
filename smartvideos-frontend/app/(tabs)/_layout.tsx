import { Tabs } from 'expo-router';
import React from 'react';
import { TouchableOpacity, StyleSheet, View } from 'react-native';

import { HapticTab } from '@/components/haptic-tab';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Ionicons } from '@expo/vector-icons';

export default function TabLayout() {
  const colorScheme = useColorScheme();

  function PlusButton(props: any) {
    return (
      <TouchableOpacity {...props} onPress={props.onPress} style={styles.plusOuter} accessibilityRole="button">
        <View style={styles.plusInner}>
          <Ionicons name="add" size={24} color="#FF4500" />
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: '#FF4500',
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarStyle: {
          backgroundColor: 'black',
          borderTopWidth: 0,
          elevation: 0,
          shadowOpacity: 0,
        },
        tabBarLabelStyle: { fontWeight: '900' },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'FIRE',
          tabBarIcon: ({ color }) => <Ionicons name="flame" size={20} color={color} />,
        }}
      />

      <Tabs.Screen
        name="/upload"
        options={{
          title: '',
          tabBarButton: (props: any) => <PlusButton {...props} />,
        }}
      />

      <Tabs.Screen
        name="/profile"
        options={{
          title: '',
          tabBarIcon: ({ color }) => <Ionicons name="person" size={26} color={color} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  plusOuter: {
    top: -18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  plusInner: {
    backgroundColor: 'white',
    width: 64,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    // TikTok-like shadow/border accent
    borderLeftWidth: 3,
    borderLeftColor: '#00aeef',
    borderRightWidth: 3,
    borderRightColor: '#ff2d55',
  },
});
