//  @ts-check

import comments from '@eslint-community/eslint-plugin-eslint-comments/configs'
import { tanstackConfig } from '@tanstack/eslint-config'
import pluginQuery from '@tanstack/eslint-plugin-query'
import pluginRouter from '@tanstack/eslint-plugin-router'
import eslintReact from '@eslint-react/eslint-plugin'
import vitest from '@vitest/eslint-plugin'
import betterTailwind from 'eslint-plugin-better-tailwindcss'
import noUnsanitized from 'eslint-plugin-no-unsanitized'
import regexp from 'eslint-plugin-regexp'
import jsxA11y from 'eslint-plugin-jsx-a11y-x'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default [
  ...tanstackConfig,
  {
    files: ['**/*.{js,ts,tsx}'],
    languageOptions: {
      parserOptions: { project: null, projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  ...[...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked].map((config) => ({
    ...config,
    files: ['**/*.{ts,tsx}'],
  })),
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',
      '@typescript-eslint/no-empty-function': ['error', { allow: ['arrowFunctions', 'methods', 'asyncMethods'] }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      '@typescript-eslint/no-invalid-void-type': ['error', { allowInGenericTypeArguments: true }],
      '@typescript-eslint/only-throw-error': [
        'error',
        {
          allow: [{ from: 'package', package: '@tanstack/router-core', name: ['Redirect', 'NotFoundError'] }],
        },
      ],
      '@typescript-eslint/prefer-nullish-coalescing': ['error', { ignorePrimitives: { string: true } }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: false }],
      'no-shadow': 'off',
      '@typescript-eslint/no-shadow': 'error',
    },
  },
  {
    ...eslintReact.configs['recommended-type-checked'],
    files: ['src/**/*.{ts,tsx}'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      // react-hooks owns the hook rules.
      '@eslint-react/exhaustive-deps': 'off',
      '@eslint-react/rules-of-hooks': 'off',
      '@eslint-react/set-state-in-effect': 'off',
      '@eslint-react/naming-convention-ref-name': 'off',
      '@eslint-react/no-use-context': 'off',
    },
  },
  comments.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: { '@eslint-community/eslint-comments/require-description': 'error' },
  },
  regexp.configs['flat/recommended'],
  { rules: { 'regexp/no-super-linear-move': 'error' } },
  noUnsanitized.configs.recommended,
  ...pluginQuery.configs['flat/recommended-strict'],
  ...pluginRouter.configs['flat/recommended'],
  {
    ...betterTailwind.configs.recommended,
    files: ['src/**/*.tsx'],
    settings: { 'better-tailwindcss': { entryPoint: 'src/styles.css' } },
    rules: {
      ...betterTailwind.configs.recommended.rules,
      // Prettier owns line breaks.
      'better-tailwindcss/enforce-consistent-line-wrapping': 'off',
      // Plain classes from src/styles.css: num for tabular figures, dark for the dark variant.
      'better-tailwindcss/no-unknown-classes': ['error', { ignore: ['num', 'dark'] }],
    },
  },
  {
    ...jsxA11y.configs.recommended,
    files: ['src/**/*.tsx'],
  },
  {
    ...reactHooks.configs.flat['recommended-latest'],
    files: ['src/**/*.{ts,tsx}'],
  },
  {
    // Tape does not run the React Compiler, so the rules that only gate compilation stay off.
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'react-hooks/incompatible-library': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
    },
  },
  {
    // The dYdX client exports none of its order enums, so the adapter passes their numbers.
    files: ['packages/trade/src/dydx/**'],
    rules: {
      '@typescript-eslint/no-unsafe-enum-assignment': 'off',
      '@typescript-eslint/no-unsafe-enum-comparison': 'off',
    },
  },
  {
    ...vitest.configs.recommended,
    files: ['**/*.test.{ts,tsx}'],
    rules: {
      ...vitest.configs.recommended.rules,
      'vitest/expect-expect': ['error', { assertFunctionNames: ['expect', 'expectSig'] }],
    },
  },
  {
    files: ['**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    files: ['src/**', 'packages/**'],
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-unassigned-vars': 'error',
      'no-useless-assignment': 'error',
      'preserve-caught-error': 'error',
    },
  },
  {
    // Trading secrets live in the vault, so storage stays behind it.
    files: ['src/**', 'packages/**'],
    ignores: ['src/trade/vault.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          globals: [
            { name: 'localStorage', message: 'Read and write storage through src/trade/vault.ts.' },
            { name: 'sessionStorage', message: 'Read and write storage through src/trade/vault.ts.' },
          ],
          checkGlobalObject: true,
        },
      ],
    },
  },
  {
    // Private keys are made and used only inside the trading package.
    files: ['src/**', 'packages/core/**', 'packages/venues/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['viem/accounts', '@noble/curves', '@noble/curves/*', '@dydxprotocol/v4-client-js'],
              message: 'Keys are made and used only in packages/trade.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression[source.value=/^(viem\\/accounts|@noble\\/curves|@dydxprotocol\\/v4-client-js)/]',
          message: 'Keys are made and used only in packages/trade.',
        },
      ],
    },
  },
  {
    // Math.random is fine for reconnect jitter and nothing else: ids, nonces and keys use crypto.
    files: ['src/**', 'packages/**'],
    ignores: ['src/hub/worker.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use crypto.getRandomValues or crypto.randomUUID.' },
      ],
    },
  },
  {
    rules: {
      'import/order': 'off',
      'sort-imports': 'off',
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    ignores: [
      'eslint.config.js',
      'prettier.config.js',
      '.output/**',
      '**/.cache/**',
      '.claude/worktrees/**',
      '.intent/**',
      'src/routeTree.gen.ts',
      '.claude/skills/verify-tape/scripts/vite.verify.config.ts',
    ],
  },
]
