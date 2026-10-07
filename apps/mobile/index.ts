// Installs quick-crypto as globalThis.crypto before anything imports nostr-tools (mobile spec 2.4).
import './src/crypto/install';
import { AppRegistry } from 'react-native';
import ShareRoot from './src/share/ShareRoot';

// The share activity's surface, on the same runtime (mobile spec 8.5).
AppRegistry.registerComponent('share', () => ShareRoot);

// The main surface: Expo Router, routes in src/app (mobile spec 6.1).
import 'expo-router/entry';
