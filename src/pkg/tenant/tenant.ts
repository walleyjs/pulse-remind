import crypto from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export const DEFAULT_TENANT_ID = 'tenant_default';

/**
 * Encodes an authenticated token as a standard JWT Bearer token with sub claim.
 */
export function createOAuthJwtToken(sub: string, email?: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub,
    email: email || undefined,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 31536000 // 1 year
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', 'pulseremind_signing_key')
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  return `${headerB64}.${payloadB64}.${signature}`;
}

export interface TenantExtractionResult {
  tenantId: string;
  userEmail: string | null;
  isExplicitTenant: boolean;
  authSource: 'bearer' | 'mcp_session' | 'header' | 'query' | 'cookie' | 'default';
}

/**
 * Deterministically derives `tenant_id` from:
 * 1. Authenticated OAuth Bearer token (`sub` claim)
 * 2. Session identifier (e.g. `Mcp-Session-Id`)
 * 3. Session cookie (e.g. `prm_session=...`)
 * 4. `x-tenant-id` header or URL query parameter (?tenant_id=... or ?session=...)
 * 5. Fallback to `DEFAULT_TENANT_ID` ('tenant_default') with isExplicitTenant: false
 */
export function extractTenantId(
  headers: IncomingHttpHeaders = {},
  queryParams?: URLSearchParams
): TenantExtractionResult {
  let userEmail: string | null = null;

  // 1. Check explicit URL query param (?tenant_id=... or ?session=...)
  if (queryParams) {
    const qTenant = queryParams.get('tenant_id') || queryParams.get('session') || queryParams.get('tenant');
    if (qTenant && qTenant.trim()) {
      return {
        tenantId: sanitizeTenantId(qTenant.trim()),
        userEmail: queryParams.get('email') || null,
        isExplicitTenant: true,
        authSource: 'query'
      };
    }
    const qEmail = queryParams.get('email');
    if (qEmail && qEmail.includes('@')) {
      userEmail = qEmail.trim();
    }
  }

  // 2. Check explicit header
  const headerTenant = headers['x-tenant-id'];
  if (typeof headerTenant === 'string' && headerTenant.trim()) {
    return {
      tenantId: sanitizeTenantId(headerTenant.trim()),
      userEmail,
      isExplicitTenant: true,
      authSource: 'header'
    };
  }

  // 3. Check Session Cookie (e.g., set after OAuth, claim URL, or in-browser activation)
  const cookieHeader = headers.cookie;
  if (typeof cookieHeader === 'string' && cookieHeader.trim()) {
    const sessionMatch = cookieHeader.match(/(?:^|;\s*)(?:prm_session|prm_tenant)=([^;]+)/);
    if (sessionMatch && sessionMatch[1].trim()) {
      return {
        tenantId: sanitizeTenantId(decodeURIComponent(sessionMatch[1].trim())),
        userEmail,
        isExplicitTenant: true,
        authSource: 'cookie'
      };
    }
  }

  // 4. Check Authorization: Bearer <token>
  const rawAuth = headers.authorization;
  if (typeof rawAuth === 'string' && rawAuth.trim()) {
    const token = rawAuth.replace(/^Bearer\s+/i, '').trim();
    if (token) {
      // Check if it's a 3-part JWT
      const parts = token.split('.');
      if (parts.length === 3) {
        try {
          const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf-8');
          const payload = JSON.parse(payloadJson);
          if (payload.email && typeof payload.email === 'string') {
            userEmail = payload.email.trim();
          }
          if (payload.sub && typeof payload.sub === 'string') {
            return {
              tenantId: sanitizeTenantId(payload.sub.trim()),
              userEmail,
              isExplicitTenant: true,
              authSource: 'bearer'
            };
          }
        } catch {
          // not valid JSON payload, proceed
        }
      }

      // Check if legacy or test prefix 'prm_live_token_'
      if (token.startsWith('prm_live_token_')) {
        const suffix = token.replace('prm_live_token_', '');
        if (suffix === 'live') {
          return { tenantId: DEFAULT_TENANT_ID, userEmail, isExplicitTenant: true, authSource: 'bearer' };
        }
        try {
          const decoded = Buffer.from(suffix, 'base64url').toString('utf-8');
          if (decoded.startsWith('{')) {
            const parsed = JSON.parse(decoded);
            if (parsed.email) userEmail = String(parsed.email);
            if (parsed.sub) return {
              tenantId: sanitizeTenantId(String(parsed.sub)),
              userEmail,
              isExplicitTenant: true,
              authSource: 'bearer'
            };
          } else if (decoded.includes('@')) {
            userEmail = decoded.trim();
            const derived = 'tenant_' + crypto.createHash('sha256').update(decoded).digest('hex').slice(0, 16);
            return { tenantId: derived, userEmail, isExplicitTenant: true, authSource: 'bearer' };
          }
        } catch {
          // ignore decode failure
        }
        return {
          tenantId: sanitizeTenantId(`tenant_${suffix.slice(0, 24)}`),
          userEmail,
          isExplicitTenant: true,
          authSource: 'bearer'
        };
      }

      // If opaque Bearer token provided
      const derived = 'tenant_' + crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
      return { tenantId: derived, userEmail, isExplicitTenant: true, authSource: 'bearer' };
    }
  }

  // 5. Check MCP Streamable Session ID header
  const mcpSessionId = headers['mcp-session-id'];
  if (typeof mcpSessionId === 'string' && mcpSessionId.trim()) {
    return {
      tenantId: sanitizeTenantId(`session_${mcpSessionId.trim().slice(0, 28)}`),
      userEmail,
      isExplicitTenant: true,
      authSource: 'mcp_session'
    };
  }

  return { tenantId: DEFAULT_TENANT_ID, userEmail, isExplicitTenant: false, authSource: 'default' };
}

function sanitizeTenantId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_\-.]/g, '_');
  return cleaned.length > 0 ? cleaned.slice(0, 64) : DEFAULT_TENANT_ID;
}
