// Must run before anything imports nostr-tools: noble's signing and NIP-44 nonces read
// globalThis.crypto.getRandomValues, which Hermes lacks (mobile spec 2.4).
import { install } from 'react-native-quick-crypto';

install();
