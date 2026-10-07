// The root JS stack (mobile spec 6.1): Welcome until it is answered, then the tabs; the Reader once there is an
// identity. Pushed screens sit in this stack over the tabs, with no tab bar on them. The sheet and toast hosts sit
// above the navigator. The spec's push and pop (motion spec, Navigation: fade with 24 px of travel, enter 250 ms,
// exit 200 ms), no swipe gesture, and the root-back switch so Android's back-to-home preview plays on root screens.
import { useEffect, useSyncExternalStore } from 'react';
import { AppState, Easing, View } from 'react-native';
import { useFonts } from 'expo-font';
import { usePathname } from 'expo-router';
import { Stack } from 'expo-router/js-stack';
import type { StackCardInterpolationProps } from 'expo-router/js-stack';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { motion } from '@shelf/tokens';
import { ShelfSystem } from '../../modules/shelf-system/src';
import { boot, useApp } from '../services/app';
import { startSync } from '../services/runner';
import { FONTS } from '../ui/fonts';
import { PlayerHost } from '../screens/Player';
import { SheetHost, sheetOpen } from '../ui/sheet';
import { ToastHost, settleToast } from '../ui/toast';
import { useTheme } from '../ui/theme';

const bezier = (e: 'linear' | readonly number[]) => (e === 'linear' ? Easing.linear : Easing.bezier(e[0], e[1], e[2], e[3]));

function fadeTravel({ current }: StackCardInterpolationProps) {
  return {
    cardStyle: {
      opacity: current.progress,
      transform: [{ translateX: current.progress.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }],
    },
  };
}

const ROOTS = ['/', '/listen', '/you', '/welcome'];

export default function Layout() {
  const path = usePathname();
  const [fonts] = useFonts(FONTS);
  const app = useApp();
  const { c, name } = useTheme();
  useEffect(() => {
    boot();
    // A toast still counting down when the app leaves the screen counts as closed without Undo.
    const sub = AppState.addEventListener('change', (s) => s !== 'active' && settleToast());
    return () => sub.remove();
  }, []);
  // The resolver first (mobile spec 3.1), then a sync, and another at each return to the foreground (4.5).
  useEffect(startSync, []);
  // Android's back-to-home preview plays only at a root screen with nothing open over it (5.1): with a sheet up,
  // Back belongs to the sheet.
  const sheetUp = useSyncExternalStore(sheetOpen.subscribe, sheetOpen.get);
  useEffect(() => {
    ShelfSystem.setRootBack(ROOTS.includes(path) && !sheetUp);
  }, [path, sheetUp]);
  // Until the fonts and the resolver are ready, the splash stays (6.9).
  if (!fonts || !app) return <View style={{ flex: 1, backgroundColor: c.background }} />;
  const shelf = app.route === 'saves';
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: c.background }}>
      <SafeAreaProvider>
        <StatusBar style={name === 'dark' ? 'light' : 'dark'} />
        <Stack
          screenOptions={{
            headerShown: false,
            gestureEnabled: false,
            detachPreviousScreen: false,
            cardOverlayEnabled: false,
            cardStyle: { backgroundColor: c.background },
            cardStyleInterpolator: fadeTravel,
            transitionSpec: {
              open: { animation: 'timing', config: { duration: motion.enter.duration, easing: bezier(motion.enter.easing) } },
              close: { animation: 'timing', config: { duration: motion.exit.duration, easing: bezier(motion.exit.easing) } },
            },
          }}
        >
          <Stack.Protected guard={shelf}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="search" />
          </Stack.Protected>
          <Stack.Protected guard={!shelf}>
            <Stack.Screen name="welcome" />
            <Stack.Screen name="return" />
          </Stack.Protected>
          <Stack.Protected guard={!!app.owner}>
            <Stack.Screen name="reader/[hash]/index" />
            <Stack.Screen name="reader/[hash]/original" />
          </Stack.Protected>
          <Stack.Screen name="gates" />
          <Stack.Screen name="back-test" />
        </Stack>
        <PlayerHost />
        <ToastHost />
        <SheetHost />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
