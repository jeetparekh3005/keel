// ESLint flat config (ESLint 10). eslint-config-next 16 ships native flat configs, so spread its
// core-web-vitals array directly. The Next 16 CLI dropped `next lint`, so `lint` runs eslint.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

const config = [
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', 'coverage/**'] },
  ...nextCoreWebVitals,
];

export default config;
