import { requireNativeModule } from 'expo-modules-core';

/** libsecp256k1 through JNI (mobile spec 8). Hex in, hex out; all synchronous. */
export interface KefliSecpModule {
  publicKey(secretKey: string): string;
  sign(hash: string, secretKey: string, aux: string): string;
  verify(signature: string, hash: string, publicKey: string): boolean;
  sharedX(secretKey: string, publicKey: string): string;
}

export default requireNativeModule<KefliSecpModule>('KefliSecp');
