import React, { useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import GoTunesScreen from './screens/GoTunesScreen';
import GoStoreScreen from './screens/GoStoreScreen';

const Tab = createBottomTabNavigator();

export default function App() {
  const [token, setToken] = useState(null);

  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={{
          headerShown: false,
          tabBarStyle: { backgroundColor: '#0b0c10', borderTopColor: '#232533' },
          tabBarActiveTintColor: '#00d2ff',
          tabBarInactiveTintColor: '#8a8d9b',
        }}
      >
        <Tab.Screen name="goTunes">
          {props => <GoTunesScreen {...props} token={token} setToken={setToken} />}
        </Tab.Screen>
        <Tab.Screen name="goStore" component={GoStoreScreen} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
