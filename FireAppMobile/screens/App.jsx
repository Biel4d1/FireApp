import React, { useContext } from 'react';
import { ActivityIndicator, View, StyleSheet } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { AuthProvider, AuthContext } from '../lib/auth';
import AuthScreen from './AuthScreen';
import GoTunesScreen from './GoTunesScreen';
import GoStoreScreen from './GoStoreScreen';

const Tab = createBottomTabNavigator();

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: '#0b0c10', borderTopColor: '#232533' },
        tabBarActiveTintColor: '#00d2ff',
        tabBarInactiveTintColor: '#8a8d9b',
      }}
    >
      <Tab.Screen name="goTunes" component={GoTunesScreen} />
      <Tab.Screen name="goStore" component={GoStoreScreen} />
    </Tab.Navigator>
  );
}

function MainNavigator() {
  const { token, loading } = useContext(AuthContext);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#00d2ff" />
      </View>
    );
  }

  return (
    <NavigationContainer>
      {!token ? <AuthScreen /> : <MainTabs />}
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <MainNavigator />
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0b0c10',
  },
});
