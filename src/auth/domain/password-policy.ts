/** Password policy (PRD §15.1). Length is the MVP rule; keep it pure and testable. */

export interface PasswordPolicy {
  readonly minLength: number;
}

export type PasswordProblem = 'too_short' | 'too_long';

export const MAX_PASSWORD_LENGTH = 1024;

export function validatePassword(password: string, policy: PasswordPolicy): PasswordProblem | null {
  if (password.length < policy.minLength) return 'too_short';
  if (password.length > MAX_PASSWORD_LENGTH) return 'too_long';
  return null;
}

export function passwordProblemMessage(problem: PasswordProblem, policy: PasswordPolicy): string {
  switch (problem) {
    case 'too_short':
      return `Password must be at least ${policy.minLength} characters.`;
    case 'too_long':
      return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  }
}
