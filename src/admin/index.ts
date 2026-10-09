export { createAdminService, type AdminService } from './application/admin-service.ts';
export type { AdminDeps } from './application/deps.ts';
export type { Division, DivisionRepository } from './ports/division-repository.ts';
export { DrizzleDivisionRepository } from './infrastructure/drizzle-division-repository.ts';
export { adminRoutes } from './http/routes.ts';
