export const browserGrantLifetimeMs = 60_000;
export const browserSessionLifetimeMs = 12 * 60 * 60 * 1_000;

interface Grant {
  readonly expiresAt: number;
  readonly origin: string;
}

export interface BrowserSession {
  readonly expiresAt: number;
}

export interface IssuedGrant {
  readonly expiresAt: number;
  readonly secret: string;
}

export interface IssuedSession extends BrowserSession {
  readonly secret: string;
}

export interface BrowserAuthority {
  readonly authenticate: (authorization: string | null) => BrowserSession | undefined;
  readonly exchange: (grant: string, origin: string) => IssuedSession | undefined;
  readonly issue: (origin: string) => IssuedGrant;
}

const secureSecret = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
};

const hash = (secret: string): string =>
  new Bun.CryptoHasher("sha256").update(secret).digest("base64url");

export const browserAuthority = (
  options: { readonly now?: () => number; readonly secret?: () => string } = {},
): BrowserAuthority => {
  const now = options.now ?? Date.now;
  const nextSecret = options.secret ?? secureSecret;
  const grants = new Map<string, Grant>();
  const sessions = new Map<string, BrowserSession>();

  const authenticate = (authorization: string | null): BrowserSession | undefined => {
    if (authorization === null || !authorization.startsWith("Bearer ")) return undefined;
    const secret = authorization.slice("Bearer ".length);
    if (secret.length === 0) return undefined;
    const key = hash(secret);
    const session = sessions.get(key);
    if (session === undefined) return undefined;
    if (now() >= session.expiresAt) {
      sessions.delete(key);
      return undefined;
    }
    return session;
  };

  const exchange = (grant: string, origin: string): IssuedSession | undefined => {
    const key = hash(grant);
    const issued = grants.get(key);
    if (issued === undefined || issued.origin !== origin || now() >= issued.expiresAt) {
      if (issued !== undefined && now() >= issued.expiresAt) grants.delete(key);
      return undefined;
    }
    grants.delete(key);
    const secret = nextSecret();
    const session = { expiresAt: now() + browserSessionLifetimeMs };
    sessions.set(hash(secret), session);
    return { ...session, secret };
  };

  const issue = (origin: string): IssuedGrant => {
    const secret = nextSecret();
    const grant = { expiresAt: now() + browserGrantLifetimeMs, origin };
    grants.set(hash(secret), grant);
    return { ...grant, secret };
  };

  return { authenticate, exchange, issue };
};
