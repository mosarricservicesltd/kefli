// npm run verify -w packages/protocol [-- --relays a,b,c]
//
// Checks every save of an identity on the relays (mobile spec 13.1, the stage gates): each event verifies and
// decrypts, and its text blob is on every server it names and matches text_hash. The secret comes from
// KEFLI_SECRET: 64 hex characters, an nsec, or the twelve words. Use test identities only; the secret never
// reaches a log. Exit status 0 when every save checks out.

import { run, verifyCommand } from './commands';

run(verifyCommand);
