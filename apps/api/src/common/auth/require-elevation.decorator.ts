import { SetMetadata } from '@nestjs/common';

export const REQUIRE_ELEVATION_KEY = 'requireElevation';

/** Critical admin ops: requires a fresh elevatedUntil after password step-up. */
export const RequireElevation = () => SetMetadata(REQUIRE_ELEVATION_KEY, true);
