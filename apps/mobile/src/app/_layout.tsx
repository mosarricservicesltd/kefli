// The root JS stack (mobile spec 6.1), as the week-0 gate needs it: the spec's push and pop (motion spec,
// Navigation: fade with 24 px of travel, enter 250 ms, exit 200 ms), no swipe gesture, and the root-back
// switch so Android's back-to-home preview plays on the root screen.
import { useEffect } from 'react';
import { Easing } from 'react-native';
import { usePathname } from 'expo-router';
import { Stack } from 'expo-router/js-stack';
import type { StackCardInterpolationProps } from 'expo-router/js-stack';
import { motion } from '@shelf/tokens';
import { ShelfSystem } from '../../modules/shelf-system/src';
import { runOutbox } from '../services/runner';
import { launchPlan } from '../services/launchState';

const bezier = (e: 'linear' | readonly number[]) => (e === 'linear' ? Easing.linear : Easing.bezier(e[0], e[1], e[2], e[3]));

function fadeTravel({ current }: StackCardInterpolationProps) {
  return {
    cardStyle: {
      opacity: current.progress,
      transform: [{ translateX: current.progress.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }],
    },
  };
}

export default function Layout() {
  const path = usePathname();
  // Whatever a share or an earlier run left in the outbox goes out when the app opens (mobile spec 4.3).
  // The resolver first (mobile spec 3.1), then the outbox.
  useEffect(() => {
    launchPlan()
      .then((p) => console.log(`[shelf-launch] ${JSON.stringify(p)}`))
      .catch((e) => console.log(`[shelf-launch] ${JSON.stringify({ error: String((e as Error).message) })}`))
      .finally(() => runOutbox().catch(() => {}));
  }, []);
  useEffect(() => {
    const ok = ShelfSystem.setRootBack(path === '/');
    console.log(`[shelf-gates] ${JSON.stringify({ id: 'root-back', ok, detail: `at ${path}, system preview ${path === '/' ? 'on' : 'off'}`, ms: 0 })}`);
  }, [path]);
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        gestureEnabled: false,
        detachPreviousScreen: false,
        cardOverlayEnabled: false,
        cardStyle: { backgroundColor: '#F3F2EE' },
        cardStyleInterpolator: fadeTravel,
        transitionSpec: {
          open: { animation: 'timing', config: { duration: motion.enter.duration, easing: bezier(motion.enter.easing) } },
          close: { animation: 'timing', config: { duration: motion.exit.duration, easing: bezier(motion.exit.easing) } },
        },
      }}
    />
  );
}
