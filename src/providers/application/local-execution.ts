import { AppError } from '@/errors.ts';
import { isLocalAdapter } from '../domain/local-model.ts';

/**
 * Browser-executed models never reach the server inference path: the SPA runs them with
 * WebLLM and posts the finished turns back for storage.
 */
export function assertServerExecution(providerAdapter: string): void {
  if (!isLocalAdapter(providerAdapter)) return;
  throw new AppError(
    'unsupported_for_model',
    'This model runs in the browser, not on the server.',
  );
}
