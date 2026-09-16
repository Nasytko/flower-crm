import { Role } from '@erp/shared';

export interface AuthenticatedUser {
  id: string;
  name: string;
  login: string;
  email?: string | null;
  role: Role;
  sessionId: string;
  isActive: boolean;
}

export interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}
