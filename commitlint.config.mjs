// Conventional Commits config. Enforced on PR titles in CI (squash merges),
// and usable locally via `npx commitlint`.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'docs', 'chore', 'refactor', 'perf', 'test', 'build', 'ci', 'style', 'revert'],
    ],
    'scope-enum': [
      2,
      'always',
      ['python', 'ts', 'rust', 'go', 'java', 'ci', 'docs', 'platform', 'auth', 'db', 'security'],
    ],
    'scope-empty': [0], // scope is optional
    'subject-case': [0],
  },
};
