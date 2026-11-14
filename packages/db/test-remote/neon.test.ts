import { describe } from 'vitest';
import { defineRuntimeRoleSuite } from './runtime-role-suite.ts';

const url = process.env.AR_REMOTE_APP_URL;
const env = process.env.AR_REMOTE_EXPECT_ENV;
if (!url || !env) throw new Error('Run via `npm run db:remote -- verify --env <development|production>`.');

describe(`Neon runtime role (${env})`, () => {
  defineRuntimeRoleSuite({ url: () => url, expectEnvironment: env, requireTls: true });
});
