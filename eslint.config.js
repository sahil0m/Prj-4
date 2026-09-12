import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * Lint rules chosen to catch the classes of bug that actually reach
 * production in a real-time TypeScript product: floating promises,
 * unhandled rejections, unsafe `any` flowing through a boundary, and
 * accidental `==` comparisons.
 *
 * Rules are errors, not warnings. A warning nobody fixes is noise.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'docs/**',
      '**/*.config.js',
      '**/*.config.ts',
      // Plain Node build tooling. Not part of any tsconfig project, and
      // verified by CI executing it rather than by static analysis.
      'scripts/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },

    rules: {
      /* --- correctness --------------------------------------------- */

      // A promise nobody awaits is a bug waiting for production traffic.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',

      // `any` silently disables every other check downstream of it.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'no-alert': 'error',

      /* --- clarity -------------------------------------------------- */

      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',

      /* --- deliberate relaxations ----------------------------------- */

      // Zod schema builders are deeply generic; the strict template rules
      // fight them without catching real bugs.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      // Mongoose and Zod both legitimately produce deep generic unions.
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
    },
  },

  /* Scripts and tests get a slightly looser leash. */
  {
    files: ['**/scripts/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
);
