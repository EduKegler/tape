//  @ts-check

import comments from '@eslint-community/eslint-plugin-eslint-comments/configs'
import { tanstackConfig } from '@tanstack/eslint-config'
import pluginQuery from '@tanstack/eslint-plugin-query'
import pluginRouter from '@tanstack/eslint-plugin-router'
import eslintReact from '@eslint-react/eslint-plugin'
import vitest from '@vitest/eslint-plugin'
import betterTailwind from 'eslint-plugin-better-tailwindcss'
import { getDefaultSelectors } from 'eslint-plugin-better-tailwindcss/defaults'
import noUnsanitized from 'eslint-plugin-no-unsanitized'
import playwright from 'eslint-plugin-playwright'
import regexp from 'eslint-plugin-regexp'
import jsxA11y from 'eslint-plugin-jsx-a11y-x'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

const KEY_IMPORTS = {
  group: ['viem/accounts', '@noble/curves', '@noble/curves/*', '@dydxprotocol/v4-client-js'],
  message: 'Keys are made and used only in packages/trade.',
}
const KEY_IMPORT_EXPRESSIONS = {
  selector: 'ImportExpression[source.value=/^(viem\\/accounts|@noble\\/curves|@dydxprotocol\\/v4-client-js)/]',
  message: 'Keys are made and used only in packages/trade.',
}

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
    settings: {
      'better-tailwindcss': {
        entryPoint: 'src/styles.css',
        selectors: [
          ...getDefaultSelectors(),
          { kind: 'variable', name: '^classes$', match: [{ type: 'objectValues' }] },
        ],
      },
    },
    rules: {
      ...betterTailwind.configs.recommended.rules,
      // Prettier owns line breaks.
      'better-tailwindcss/enforce-consistent-line-wrapping': 'off',
      // Plain classes from src/styles.css: num for tabular figures.
      'better-tailwindcss/no-unknown-classes': ['error', { ignore: ['num'] }],
      'better-tailwindcss/no-restricted-classes': [
        'error',
        {
          restrict: [
            {
              pattern:
                '^(?:[^:]+:)*!?-?(?:(?:text|font|leading|tracking|(?:scroll-)?[pm](?:[xytrblse]|b[se])?|gap(?:-[xy])?|space-[xy]|rounded(?:-[a-z]+)?|(?:inset-|drop-)?shadow|z|duration)-[\\[(]|text-(?:\\d*xs|sm|base|md|lg|\\d*xl)\\/[\\[(]|(?:z|duration)-\\d)',
              message: 'Use a token from src/styles.css, not an arbitrary or bare value.',
            },
            {
              pattern:
                '^(?:[^:]+:)*!?\\[(?:font-|line-height|letter-spacing|(?:scroll-)?(?:padding|margin)|(?:row-|column-)?gap|border(?:-[a-z]+)*-radius|z-index|transition-duration)',
              message: 'Use a token from src/styles.css, not an arbitrary property.',
            },
            {
              pattern: '^(?:[^:]+:)*!?rounded(?:-[a-z]+)?-full$',
              message: 'Use rounded-sm. The radius scale has one step.',
            },
          ],
        },
      ],
    },
  },
  {
    ...jsxA11y.configs.recommended,
    files: ['src/**/*.tsx'],
    settings: { 'jsx-a11y-x': { components: { Button: 'button' } } },
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
      'no-restricted-imports': ['error', { patterns: [KEY_IMPORTS] }],
      'no-restricted-syntax': ['error', KEY_IMPORT_EXPRESSIONS],
    },
  },
  {
    // ESLint's flat config replaces a rule's options in a later block, so the key restrictions repeat here.
    files: ['src/**'],
    ignores: ['src/ui/primitives/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            KEY_IMPORTS,
            { group: ['@base-ui/react', '@base-ui/react/*'], message: 'Use the primitives in src/ui/primitives.' },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        KEY_IMPORT_EXPRESSIONS,
        {
          selector: 'ImportExpression[source.value=/^@base-ui\\/react/]',
          message: 'Use the primitives in src/ui/primitives.',
        },
        { selector: "JSXOpeningElement[name.name='button']", message: 'Use Button from src/ui/primitives.' },
        { selector: "JSXOpeningElement[name.name='table']", message: 'Use Table from src/ui/primitives.' },
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
    // @tanstack/eslint-config registers the import plugin for these files only.
    files: ['**/*.{js,ts,tsx}'],
    rules: {
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          // import-x does not classify package.json subpath imports, so #/ needs a path group.
          pathGroups: [{ pattern: '#/**', group: 'internal' }],
        },
      ],
    },
  },
  {
    rules: {
      'sort-imports': 'off',
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    ...playwright.configs['flat/recommended'],
    files: ['e2e/**/*.ts'],
    rules: {
      ...playwright.configs['flat/recommended'].rules,
      'playwright/no-focused-test': 'error',
      'playwright/no-skipped-test': 'error',
    },
  },
  {
    ignores: [
      'eslint.config.js',
      'prettier.config.js',
      '.output/**',
      '**/.cache/**',
      '.claude/skills/verify-tape/.state/**',
      '.claude/skills/verify-tape/artifacts/**',
      'e2e/results/**',
      '.claude/worktrees/**',
      '.intent/**',
      'src/routeTree.gen.ts',
      '.claude/skills/verify-tape/scripts/vite.verify.config.ts',
    ],
  },
]
