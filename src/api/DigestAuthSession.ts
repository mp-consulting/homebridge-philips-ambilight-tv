/**
 * Shared Digest Authentication session manager.
 * Caches auth parameters (realm, nonce, HA1) to avoid a 401 round-trip
 * on every request. Used by both PhilipsTVClient and NotifyChangeClient.
 */

import crypto from 'crypto';
import { parseWwwAuthenticate, md5 } from './utils.js';

// ============================================================================
// TYPES
// ============================================================================

interface CachedAuthState {
  realm: string;
  nonce: string;
  qop: string;
  opaque?: string;
  ha1: string;
  nc: number;
}

// ============================================================================
// DIGEST AUTH SESSION
// ============================================================================

export class DigestAuthSession {
  private cachedAuth: CachedAuthState | null = null;

  constructor(
    private readonly username: string,
    private readonly password: string,
  ) {}

  /** Whether we have cached credentials (can skip the initial 401). */
  get hasCachedAuth(): boolean {
    return this.cachedAuth !== null;
  }

  /** Clear cached auth state (e.g., on nonce expiry). */
  clear(): void {
    this.cachedAuth = null;
  }

  /**
   * Build a digest Authorization header using cached auth parameters.
   * Increments the nonce count for each use.
   * Returns null if no cached auth is available.
   */
  buildHeader(method: string, uri: string): string | null {
    if (!this.cachedAuth) {
      return null;
    }

    const auth = this.cachedAuth;
    auth.nc++;
    const nc = auth.nc.toString(16).padStart(8, '0');
    const cnonce = crypto.randomBytes(16).toString('hex');

    const ha2 = md5(`${method}:${uri}`);
    const response = auth.qop
      ? md5(`${auth.ha1}:${auth.nonce}:${nc}:${cnonce}:${auth.qop}:${ha2}`)
      : md5(`${auth.ha1}:${auth.nonce}:${ha2}`);

    let header = `Digest username="${this.username}", realm="${auth.realm}", nonce="${auth.nonce}", uri="${uri}", response="${response}"`;

    if (auth.qop) {
      header += `, qop=${auth.qop}, nc=${nc}, cnonce="${cnonce}"`;
    }
    if (auth.opaque) {
      header += `, opaque="${auth.opaque}"`;
    }

    return header;
  }

  /**
   * Parse a WWW-Authenticate header from a 401 response and cache
   * the digest parameters for future requests.
   * Returns false if the header is not a valid Digest challenge.
   */
  cacheFromChallenge(wwwAuthHeader: string): boolean {
    if (!wwwAuthHeader?.toLowerCase().startsWith('digest')) {
      return false;
    }

    const params = parseWwwAuthenticate(wwwAuthHeader);
    this.cachedAuth = {
      ...params,
      ha1: md5(`${this.username}:${params.realm}:${this.password}`),
      nc: 0,
    };

    return true;
  }
}
