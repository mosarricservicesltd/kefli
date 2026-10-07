import { requireNativeModule } from 'expo-modules-core';

/** mobile spec 8.6; only the root-back switch so far. */
interface ShelfSystemModule {
  /** True at a root screen with nothing open: Android's back-to-home preview plays. False hands Back to JS. */
  setRootBack(atRoot: boolean): boolean;
}

export const ShelfSystem = requireNativeModule<ShelfSystemModule>('ShelfSystem');
