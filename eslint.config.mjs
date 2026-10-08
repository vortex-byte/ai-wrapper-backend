// Flat ESLint config. Two jobs:
//  1. General TS hygiene.
//  2. The provider-import rule (PRD NFR-MAINT-1): provider SDKs may only be
//     imported from `src/providers/`. The layer *dependency rule* (AGENTS §3.2)
//     is enforced by dependency-cruiser, not ESLint.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const PROVIDER_SDK_MESSAGE =
  'Provider SDKs may only be imported from src/providers/ (PRD NFR-MAINT-1, AGENTS §5).';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      '.var/**',
      'tmp/**',
      'migrations/**',
      '*.cjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      curly: ['error', 'multi-line'],
    },
  },
  {
    // Ban provider SDK imports everywhere except the providers module.
    files: ['src/**/*.ts'],
    ignores: ['src/providers/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['openai', 'openai/*'], message: PROVIDER_SDK_MESSAGE },
            {
              group: ['@anthropic-ai/*', '@google/generative-ai', '@google/genai', '@google/*'],
              message: PROVIDER_SDK_MESSAGE,
            },
            { group: ['cohere-ai', 'mistralai', '@mistralai/*'], message: PROVIDER_SDK_MESSAGE },
          ],
        },
      ],
    },
  },
  {
    // Tests, CLI scripts and the boot path may use console/operate freely.
    files: ['tests/**/*.ts', 'src/cli/**/*.ts', 'src/server.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);
