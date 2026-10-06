// Installs quick-crypto as globalThis.crypto before anything imports nostr-tools (mobile spec 2.4).
import './src/crypto/install';
import { registerRootComponent } from 'expo';

import App from './src/Root';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
