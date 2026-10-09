// Generated from shared/tokens/tokens.json (v1.1.0, fingerprint) by shared/tokens/build-ts.mjs. Do not edit.

// Motion as Reanimated configs. Each token's use text in tokens.json says where it applies and what
// reduced motion does; this module only turns the numbers into configs.

import { Easing } from 'react-native-reanimated';
import type { WithSpringConfig, WithTimingConfig } from 'react-native-reanimated';
import { motion } from './index';

type Timing = { readonly duration: number; readonly easing: 'linear' | readonly number[] };

export function easing(e: Timing['easing']) {
  if (e === 'linear') return Easing.linear;
  const [x1, y1, x2, y2] = e;
  return Easing.bezier(x1, y1, x2, y2);
}

export function timing(m: Timing): WithTimingConfig {
  return { duration: m.duration, easing: easing(m.easing) };
}

export const enter = timing(motion.enter);
export const exit = timing(motion.exit);
export const quickIn = timing(motion.quickIn);
export const quickOut = timing(motion.quickOut);
export const reflow = timing(motion.reflow);
export const pressOut = timing(motion.press.out);
export const mark = timing(motion.mark);
export const catchUp = timing(motion.catchUp);
export const catchUpFinish = timing(motion.catchUp.finish);
export const launchIn = timing(motion.launch.in);
export const launchOut = timing(motion.launch.out);

/** The release spring; pass the gesture's velocity alongside it. */
export const release: WithSpringConfig = { ...motion.release };

/** Ambient loops: breathe, pulse and eq go there and back within one CSS cycle, so each leg is half of it. */
export const ambient = {
  breathe: timing({ ...motion.ambient.breathe, duration: motion.ambient.breathe.duration / 2 }),
  pulse: timing({ ...motion.ambient.pulse, duration: motion.ambient.pulse.duration / 2 }),
  eq: timing({ ...motion.ambient.eq, duration: motion.ambient.eq.duration / 2 }),
  scan: timing(motion.ambient.scan),
  sweep: timing(motion.ambient.sweep),
};
