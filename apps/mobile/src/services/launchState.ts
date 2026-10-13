// The resolver's plan at this launch, for the screens to route on (and the gates screen to show).
import type { LaunchPlan } from '../data/resolver';
import { launch } from './identity';

let plan: Promise<LaunchPlan> | null = null;

/** One plan per launch, shared by every caller; a launch that failed is tried again by the next call (F21). */
export function launchPlan(): Promise<LaunchPlan> {
  plan ??= launch().catch((e: unknown) => {
    plan = null;
    throw e;
  });
  return plan;
}
