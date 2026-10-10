/**
 * Methods the HTTP routes call. PrismaClient is cast to this at the request
 * boundary; tests pass an in-memory double with the same shape.
 */
export interface AppDb {
  user: {
    findUnique(args: any): Promise<any>;
    create(args: any): Promise<any>;
    update(args: any): Promise<any>;
    updateMany(args: any): Promise<{ count: number }>;
  };
  session: {
    create(args: any): Promise<any>;
    findUnique(args: any): Promise<any>;
    findMany(args: any): Promise<any[]>;
    updateMany(args: any): Promise<{ count: number }>;
    updateManyAndReturn(args: any): Promise<any[]>;
  };
  table: {
    findMany(args: any): Promise<any[]>;
    findUnique(args: any): Promise<any>;
    create(args: any): Promise<any>;
  };
  tableSeat: {
    findUnique(args: any): Promise<any>;
    findFirst(args: any): Promise<any>;
  };
  hand: {
    findUnique(args: any): Promise<any>;
    findFirst(args: any): Promise<any>;
  };
  $transaction<T>(fn: (tx: AppDb) => Promise<T>, options?: { maxWait?: number; timeout?: number }): Promise<T>;
}
