// npm run decrypt -w packages/protocol -- <event.json | -> [--blob <file>] [--fetch]
//
// Prints a save event's decrypted item JSON and checks its text blob (mobile spec 13.1), so the stage
// gates and the extension can check output without a phone. The secret comes from SHELF_SECRET: 64 hex
// characters, an nsec, or the twelve words. Use test identities only; the secret never reaches a log.
//
//   --blob <file>  check a blob already on disk
//   --fetch        fetch the blob from each server in text.servers (GET <server>/<sha256>)
// Exit status: 0 when the event verifies and decrypts and any blob checked matches, 1 otherwise.

import { decryptCommand, run } from './commands';

run(decryptCommand);
