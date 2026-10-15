// Installs quick-crypto as globalThis.crypto before anything imports nostr-tools (mobile spec 2.4).
import './src/crypto/install';
import { AppRegistry } from 'react-native';
import ShareRoot from './src/share/ShareRoot';
import { defineBackgroundSync } from './src/services/background';
import { backgroundPorts } from './src/services/runner';

// The background worker's task, defined here in the global scope (mobile spec 4.8): a run with Kefli closed starts
// this bundle, runs the task and stops without mounting a view, so no screen's code can define it.
defineBackgroundSync(backgroundPorts);

// The share activity's surface, on the same runtime (mobile spec 8.5).
AppRegistry.registerComponent('share', () => ShareRoot);

// The main surface: Expo Router, routes in src/app (mobile spec 6.1).
import 'expo-router/entry';
