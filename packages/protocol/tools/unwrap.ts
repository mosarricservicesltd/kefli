// npm run unwrap -w packages/protocol -- <wrap.json | ->
//
// Prints a gift wrap's seal signer and rumor from a test secret (mobile spec 13.1), so the extension can
// check its save requests and the phone its pair-acks without the other side. The recipient's secret
// comes from KEFLI_SECRET: 64 hex characters or an nsec (a device key has no words).

import { unwrapCommand, run } from './commands';

run(unwrapCommand);
