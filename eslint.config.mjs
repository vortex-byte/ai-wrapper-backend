import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const PROVIDER_SDK_MESSAGE = 'Provider SDKs may only be imported from src/providers/.';

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
      // --- TypeScript hygiene ---
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-expect-error': 'allow-with-description',
          minimumDescriptionLength: 3,
        },
      ],
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // --- Code shape ---
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      curly: ['error', 'multi-line'],
      // No `enum` (use `as const` / literal unions); no default exports (named only).
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSEnumDeclaration',
          message: 'Use `as const` object maps or string-literal unions instead of `enum`.',
        },
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Use named exports only — no `export default`.',
        },
      ],
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
