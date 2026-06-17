import { jwtVerify, createRemoteJWKSet } from 'jose';
import type { JWTPayload } from 'jose';
import type { MiddlewareHandler } from 'hono';
import type { Env } from './types';

type HonoEnv = { Bindings: Env; Variables: { user: JWTPayload } };

// Cached per project ref so we don't create a new JWKS fetcher on every request
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJWKS(projectRef: string) {
  if (!jwksCache.has(projectRef)) {
    jwksCache.set(
      projectRef,
      createRemoteJWKSet(
        new URL(`https://${projectRef}.supabase.co/auth/v1/.well-known/jwks.json`)
      )
    );
  }
  return jwksCache.get(projectRef)!;
}

export const authMiddleware: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or malformed Authorization header' }, 401);
  }

  const token = authHeader.slice(7);
  try {
    const { payload } = await jwtVerify(token, getJWKS(c.env.SUPABASE_PROJECT_REF), {
      audience: 'authenticated',
      issuer: `https://${c.env.SUPABASE_PROJECT_REF}.supabase.co/auth/v1`,
    });
    c.set('user', payload);
    await next();
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
};
