import app from './api/index';
import { serve } from '@hono/node-server';

const env =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

serve({ fetch: app.fetch, port: Number(env.PORT) || 3000 });
