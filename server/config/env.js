import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4100),
  // 127.0.0.1 keeps Forge to this computer. 0.0.0.0 lets the network reach it.
  HOST: z.string().default('0.0.0.0'),
  MONGO_URI: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_DAYS: z.coerce.number().int().positive().default(7),
  TRUST_PROXY: z.string().optional(),
}).superRefine((env, ctx) => {
  if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
    ctx.addIssue({ code: 'custom', message: 'The two JWT secrets must differ', path: ['JWT_REFRESH_SECRET'] });
  }
  if (env.NODE_ENV === 'production') {
    if (env.TRUST_PROXY === undefined || env.TRUST_PROXY === '') {
      ctx.addIssue({ code: 'custom', message: 'Set TRUST_PROXY in production', path: ['TRUST_PROXY'] });
    }
    if (env.TRUST_PROXY === 'true') {
      ctx.addIssue({ code: 'custom', message: 'TRUST_PROXY must never be true', path: ['TRUST_PROXY'] });
    }
  }
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  throw new Error(`Bad environment:\n${lines.join('\n')}`);
}

export const env = parsed.data;
export const isTest = env.NODE_ENV === 'test';
export const isProd = env.NODE_ENV === 'production';
export const trustProxy = env.TRUST_PROXY === undefined || env.TRUST_PROXY === 'false' || env.TRUST_PROXY === ''
  ? false
  : Number(env.TRUST_PROXY);
