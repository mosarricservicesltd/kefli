// The launch plan is shared by every caller of one launch, and a launch that failed is tried again (F21).
const mockLaunch = jest.fn();
jest.mock('../src/services/identity', () => ({ launch: () => mockLaunch() }));
// eslint-disable-next-line import/first
import { launchPlan } from '../src/services/launchState';

const PLAN = { wipeDb: false, route: 'saves', restoreCard: false, adoptBlockStore: false };

test('a failed launch is not kept: the next call reads the key file again, and its plan is then shared', async () => {
  mockLaunch.mockRejectedValueOnce(new Error('keystore not ready')).mockResolvedValue(PLAN);
  const [a, b] = [launchPlan(), launchPlan()];
  await expect(a).rejects.toThrow('keystore not ready');
  await expect(b).rejects.toThrow('keystore not ready');
  expect(mockLaunch).toHaveBeenCalledTimes(1);
  await expect(launchPlan()).resolves.toEqual(PLAN);
  await expect(launchPlan()).resolves.toEqual(PLAN);
  expect(mockLaunch).toHaveBeenCalledTimes(2);
});
