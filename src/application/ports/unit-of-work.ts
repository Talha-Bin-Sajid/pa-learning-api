/**
 * Runs `work` atomically. Repositories used inside the callback automatically
 * join the transaction; nested calls reuse the outer transaction.
 */
export interface UnitOfWork {
  run<T>(work: () => Promise<T>): Promise<T>;
}
