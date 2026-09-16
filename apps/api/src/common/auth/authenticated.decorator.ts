import { SetMetadata } from '@nestjs/common';

/** Marks an endpoint that any authenticated user may call (no permission list). */
export const AUTHENTICATED_ONLY_KEY = 'authenticatedOnly';

export const Authenticated = (): MethodDecorator & ClassDecorator =>
  SetMetadata(AUTHENTICATED_ONLY_KEY, true);
