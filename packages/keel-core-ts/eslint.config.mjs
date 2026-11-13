import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // src/genproto is the committed protobuf-es output (ADR-0022); buf owns its style, so it is
  // linted by the buf regeneration dogfood (proto.yml), not eslint.
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'src/genproto/**',
      '*.config.mjs',
      '*.config.mts',
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
  },
  {
    // Tests favor expressive assertions over the strict production rules.
    files: ['**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
  prettier,
);
