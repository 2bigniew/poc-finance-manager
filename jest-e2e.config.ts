import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  moduleNameMapper: {
    '^@app/(.*)$': '<rootDir>/src/app/$1',
    '^@config/(.*)$': '<rootDir>/src/config/$1',
  },
  testMatch: ['<rootDir>/test/**/*.e2e-spec.ts'],
  setupFiles: ['<rootDir>/test/setup-test-env.ts'],
  globalSetup: '<rootDir>/test/global-setup.ts',
  testTimeout: 30_000,
};

export default config;
