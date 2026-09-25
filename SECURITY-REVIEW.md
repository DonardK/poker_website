# Card randomness, isolation and audit review

This review describes the current model (2026-09-24). The previous player-nonce, "provably fair" shuffle was deliberately replaced to meet a strict GLI-19/MGA-style specification. That design revealed the full shuffle seed after every hand, which exposed opponents' mucked hole cards and the undealt deck to every participant. [COMPLIANCE.md](COMPLIANCE.md) maps each requirement to the code and to measured test evidence.

## Randomness

Every swap index of the Fisher-Yates (Durstenfeld) shuffle comes from a 32-bit word produced by `crypto.randomFillSync`. That is OpenSSL's NIST SP 800-90A DRBG, seeded by the operating system. A word is accepted only if it is below the largest multiple of the range that fits in 2^32, so every outcome has exactly the same number of preimages and there is no modulo bias. Tests prove the shuffle is a bijection from draw sequences to permutations. They also run chi-square tests over one million production shuffles: per position, per card, a global test with the correct (n−1)² degrees of freedom, serial independence, and whole-permutation uniformity for five items. A continuous health test rejects stuck or repeating output. An RNG failure aborts the hand start without changing the table. The code has no seeding API, no `Math.random` and no replay mode.

Every seat is dealt from the same uniformly shuffled deck in casino order, so starting-hand odds do not depend on the seat. For example, the chance of a pocket pair is 3/51 for everyone. The button and blinds change betting order and strategy, not card odds.

## Isolation

The deck, burns, salts, commitment trees and hole cards exist only in server memory and in the AES-256-GCM encrypted state. Each authenticated socket receives its own projection, built from an allow-list of fields. It contains only that player's hole cards, the board dealt so far, and the hands tabled at showdown, together with Merkle proofs for exactly those cards. Before any snapshot is emitted, an independent guard recomputes what the viewer is entitled to see. It refuses the emission (fail closed, logged as a security event) if the payload contains any other card, a board larger than the current street allows, or a server-only field. Community cards leave the deck only when their betting round starts. Bot strategy receives the same restricted view. After each hand, Clean-up purges every card secret from the live state. In production, both HTTP and Socket.io refuse plaintext connections.

## Audit trail

Each hand has a UUID v4 and UTC timestamps. A salted SHA-256 deck commitment and Merkle root are computed before dealing and published at once. Every transition is recorded in a SHA-256 hash chain. The chain is anchored to a genesis hash that includes the previous hand's final hash, and it is sealed with a post-hand verification hash. Hidden cards appear in the chain only as deck positions. Players can therefore verify the redacted record for their own hands without learning any mucked or undealt card. Regulators, through an ADMIN-only and access-logged route, receive the sealed deck and salts and a full recomputation. Audit columns are written in the same transaction that settles the hand. The runtime database role cannot modify them afterwards. A hand whose audit does not match the dealt cards is not recorded at all.

## Residual risks

- The operator's server knows the deck during a hand. Commitments make changes after the fact detectable. They do not prevent a compromised live server from seeing cards. That is a matter for operational controls: access restriction, monitoring, key custody in a KMS or HSM.
- Audit hashes are stored by the operator. Periodic publication of `finalStateHash` values to an external write-once or timestamping service is recommended, so that wholesale rewriting is detectable by third parties.
- Finite statistical samples cannot prove an RNG is perfect. An accredited laboratory must evaluate the RNG and the production environment before any real-money use.
- Anti-collusion analytics, KYC and responsible-gaming controls are not implemented. This remains a play-chip application.
