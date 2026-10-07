# Test vectors

`nip44.vectors.json`: the NIP-44 v2 vectors from https://github.com/paulmillr/nip44 (MIT), fetched 6 October 2026, sha256 `269ed0f69e4c192512cc779e78c555090cebc7c785b609e338a62afc3ce25040`.

`bip340.vectors.csv`: the BIP-340 test vectors from https://github.com/bitcoin/bips/blob/master/bip-0340/test-vectors.csv (BSD-2-Clause), fetched 7 October 2026, sha256 `34c9d1d9c3a88d524bc80778540dc43f8306ec249a7485293063c376db851c2d`. Rows whose message isn't 32 bytes are skipped, since nostr signs 32-byte event ids.
