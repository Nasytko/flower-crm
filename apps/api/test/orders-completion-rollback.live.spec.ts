/**
 * Legacy SALE-on-COMPLETED mid-transaction rollback coverage.
 * Physical leave-shop is now issue / direct-issue (see warehouse-assembly.live.spec.ts).
 */
describe('Phase 9 order completion rollback (live DB)', () => {
  it.skip('obsolete: completion no longer mid-consumes lots via SALE', () => undefined);
});
