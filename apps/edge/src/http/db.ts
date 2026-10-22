/**
 * Methods the HTTP routes call. PrismaClient is cast to this at the request
 * boundary; tests pass an in-memory double with the same shape.
 */
type Find = (args: any) => Promise<any>;
type FindMany = (args: any) => Promise<any[]>;
type Write = (args: any) => Promise<any>;
type WriteMany = (args: any) => Promise<{ count: number }>;
type Count = (args: any) => Promise<number>;

export interface AppDb {
  user: {
    findUnique: Find;
    create: Write;
    update: Write;
    updateMany: WriteMany;
  };
  session: {
    create: Write;
    findUnique: Find;
    findMany: FindMany;
    updateMany: WriteMany;
    updateManyAndReturn: FindMany;
  };
  table: {
    findMany: FindMany;
    findUnique: Find;
    create: Write;
  };
  tableSeat: {
    findUnique: Find;
    findFirst: Find;
  };
  hand: {
    findUnique: Find;
    findFirst: Find;
  };
  // Account security (migration 20261019100000_account_security).
  knownDevice: {
    findFirst: Find;
    findMany: FindMany;
    create: Write;
    update: Write;
    deleteMany: WriteMany;
    count: Count;
  };
  userTotp: {
    findUnique: Find;
    create: Write;
    updateMany: WriteMany;
    deleteMany: WriteMany;
  };
  userBackupCode: {
    createMany: WriteMany;
    updateMany: WriteMany;
    deleteMany: WriteMany;
    count: Count;
  };
  webAuthnCredential: {
    findUnique: Find;
    findFirst: Find;
    findMany: FindMany;
    create: Write;
    updateMany: WriteMany;
    deleteMany: WriteMany;
    count: Count;
  };
  emailToken: {
    create: Write;
    findUnique: Find;
    findFirst: Find;
    updateMany: WriteMany;
    deleteMany: WriteMany;
    count: Count;
  };
  authNonce: {
    findUnique: Find;
    create: Write;
    deleteMany: WriteMany;
  };
  accountSecurityEvent: {
    create: Write;
    findMany: FindMany;
    count: Count;
  };
  stepUpGrant: {
    create: Write;
    findUnique: Find;
  };
  stepUpEmailChallenge: {
    create: Write;
    findUnique: Find;
    updateMany: WriteMany;
    deleteMany: WriteMany;
    count: Count;
  };
  $transaction<T>(fn: (tx: AppDb) => Promise<T>, options?: { maxWait?: number; timeout?: number }): Promise<T>;
}
