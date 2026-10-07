// The tabs (mobile spec 6.1): Saves, Listen and You under Shelf's own tab bar, switching with a 150 ms fade.
import Tabs from 'expo-router/js-tabs';
import { motion } from '@shelf/tokens';
import { TabBar } from '../../ui/TabBar';
import { useTheme } from '../../ui/theme';

export default function TabsLayout() {
  const { c } = useTheme();
  return (
    <Tabs
      tabBar={(p) => <TabBar state={p.state} navigation={p.navigation as never} />}
      screenOptions={{
        headerShown: false,
        animation: 'fade',
        transitionSpec: { animation: 'timing', config: { duration: motion.quickIn.duration } },
        sceneStyle: { backgroundColor: c.background },
      }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="listen" />
      <Tabs.Screen name="you" />
    </Tabs>
  );
}
