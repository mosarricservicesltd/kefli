import { requireNativeModule } from 'expo-modules-core';

/** mobile spec 8.6 and 7.1. */
interface KefliSystemModule {
  /** True at a root screen with nothing open: Android's back-to-home preview plays. False hands Back to JS. */
  setRootBack(atRoot: boolean): boolean;
  /** FLAG_SECURE on the window while secrets are on screen (7.1). */
  setSecure(on: boolean): boolean;
  /** Copies text marked sensitive, hidden from the clipboard preview (7.1). */
  copySensitive(label: string, text: string): boolean;
  /** Writes the file to Downloads (8.6): MediaStore on 29 and later, the system's save dialog on 26 to 28. */
  exportToDownloads(fileName: string, contents: string): Promise<{ uri: string }>;
}

export const KefliSystem = requireNativeModule<KefliSystemModule>('KefliSystem');
