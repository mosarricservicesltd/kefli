// The resolver's plan at this launch, for the screens to route on (and the gates screen to show).
import type { LaunchPlan } from '../data/resolver';
import { launch } from './identity';

let plan: Promise<LaunchPlan> | null = null;

export function launchPlan(): Promise<LaunchPlan> {
  plan ??= launch();
  return plan;
}
