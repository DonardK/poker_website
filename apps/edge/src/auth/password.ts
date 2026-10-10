import bcrypt from "bcryptjs";

export const BCRYPT_COST = 12;

/**
 * A real cost-12 bcrypt hash of a random secret nobody knows. Login compares
 * against it whenever there is no usable password hash, so every login does
 * one bcrypt compare.
 */
export const DUMMY_PASSWORD_HASH = "$2b$12$9dPEBGq4jOLGMdzdoLFWnuXMLJCYIKMfYQaluwVLqzSoxaT1NZ.ja";

/** Object so tests can spy on compare without patching the ESM namespace. */
export const passwords = {
  compare: (password: string, passwordHash: string): Promise<boolean> => bcrypt.compare(password, passwordHash),
  hash: (password: string, cost: number): Promise<string> => bcrypt.hash(password, cost),
};
