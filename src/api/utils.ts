/**
 * Philips TV API Utilities
 */

import crypto from 'crypto';
import dgram from 'dgram';
import { isIPv4 } from 'net';
import os from 'os';
import type { TLSSocket } from 'tls';
import { Agent, buildConnector, type Dispatcher, type Headers, fetch } from 'undici';
import {
  TV_API_PORT, TV_API_VERSION, ERROR_MESSAGES, AUTH_SHARED_KEY,
  WOL_PORT, WOL_BROADCAST_IP, WOL_BURST_COUNT, WOL_PACKETS_PER_BURST, WOL_BURST_INTERVAL_MS,
} from './constants.js';
import type { DeviceInfo, DigestAuthParams, FetchOptions, PairingSession, DiscoveredDevice } from './types.js';

// ============================================================================
// HTTPS AGENT
// ============================================================================

/**
 * Unpinned agent, used for discovery and for the pairing exchange itself —
 * the point at which the TV's certificate is first seen and so cannot yet be
 * verified against anything. Prefer `createTvAgent` everywhere else.
 *
 * Philips TVs serve self-signed certificates, so ordinary chain verification
 * can never succeed; `createTvAgent` pins the exact certificate instead.
 */
export const httpsAgent: Dispatcher = new Agent({
  connect: { rejectUnauthorized: false },
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 30_000,
});

// ============================================================================
// CERTIFICATE PINNING
// ============================================================================

/** Normalize a SHA-256 fingerprint to lowercase hex with no separators. */
export const normalizeFingerprint = (fingerprint: string): string =>
  fingerprint.replace(/[:\s]/g, '').toLowerCase();

export interface TvAgentOptions {
  /** Expected certificate fingerprint. When absent the agent connects unpinned. */
  certFingerprint?: string;
  /** Called with the observed fingerprint on each successful TLS connect. */
  onCertObserved?: (fingerprint: string) => void;
  /** Called once when connecting without a pin, so the caller can warn. */
  onUnpinned?: () => void;
}

/**
 * Build a dispatcher that pins the TV's certificate.
 *
 * Chain verification stays disabled — a self-signed certificate can never
 * satisfy it — and the exact certificate captured at pairing time is compared
 * instead. A mismatch fails the connection rather than logging and continuing,
 * because at that point we are talking to something that is not the TV we
 * paired with.
 *
 * When a fingerprint is configured the connection must be TLS: otherwise an
 * attacker could sidestep the pin entirely by forcing the plaintext HTTP
 * fallback. Configs with no fingerprint (paired before pinning existed) keep
 * the old unverified behaviour so they don't break on upgrade.
 */
export const createTvAgent = (options: TvAgentOptions = {}): Dispatcher => {
  const expected = options.certFingerprint ? normalizeFingerprint(options.certFingerprint) : null;
  const baseConnector = buildConnector({ rejectUnauthorized: false });
  let warnedUnpinned = false;

  return new Agent({
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 30_000,
    connect(connectOptions, callback) {
      baseConnector(connectOptions, (err, socket) => {
        if (err) {
          return callback(err, null);
        }

        const peer = (socket as TLSSocket).getPeerCertificate?.();
        const observed = peer?.fingerprint256 ? normalizeFingerprint(peer.fingerprint256) : null;

        if (!expected) {
          if (!warnedUnpinned) {
            warnedUnpinned = true;
            options.onUnpinned?.();
          }
          if (observed) {
            options.onCertObserved?.(observed);
          }
          return callback(null, socket);
        }

        if (!observed) {
          socket.destroy();
          return callback(
            new Error('Refusing an unencrypted connection to a TV with a pinned certificate'),
            null,
          );
        }

        if (observed !== expected) {
          socket.destroy();
          return callback(
            new Error(`TV certificate does not match the pinned fingerprint (expected ${expected}, got ${observed})`),
            null,
          );
        }

        options.onCertObserved?.(observed);
        return callback(null, socket);
      });
    },
  });
};


// ============================================================================
// CRYPTO UTILITIES
// ============================================================================

export const md5 = (str: string): string =>
  crypto.createHash('md5').update(str).digest('hex');

export const hmacSignature = (timestamp: string, pin: string): string => {
  const hmac = crypto.createHmac('sha1', AUTH_SHARED_KEY);
  hmac.update(timestamp);
  hmac.update(pin);
  return hmac.digest('base64');
};

// ============================================================================
// HTTP UTILITIES
// ============================================================================

export const buildUrl = (ip: string, endpoint: string): string =>
  `https://${ip}:${TV_API_PORT}/${TV_API_VERSION}${endpoint}`;

/**
 * A fully-read HTTP response. The body is buffered before the response is
 * returned, so `text()`/`json()` resolve from memory and cannot block.
 */
export interface TimedResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}

/**
 * Largest response body accepted from a TV. The biggest legitimate payload —
 * the `/applications` list on a set with many apps installed — is well under
 * this; anything larger is a misbehaving or hostile device, and buffering it
 * whole would let it exhaust Homebridge's memory.
 */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Read a response body as text, refusing one larger than `limit` bytes. */
const readBodyWithLimit = async (response: Awaited<ReturnType<typeof fetch>>, limit: number): Promise<string> => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new Error(`Response body too large (${declared} bytes)`);
  }
  if (!response.body) {
    return '';
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.byteLength;
    if (received > limit) {
      await response.body.cancel().catch(() => {});
      throw new Error(`Response body too large (over ${limit} bytes)`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
};

export const fetchWithTimeout = async (
  url: string,
  options: { method: string; headers?: Record<string, string>; body?: string; dispatcher?: Dispatcher },
  timeout: number,
  externalSignal?: AbortSignal,
): Promise<TimedResponse> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  // If an external signal is provided, abort our controller when it fires
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      dispatcher: options.dispatcher || httpsAgent,
    });

    // Read the body while the abort timer is still armed. `fetch` resolves as
    // soon as the response headers arrive, so a TV that sends headers then
    // stalls the body would otherwise hang an un-guarded `response.text()`
    // forever. Buffering here keeps the whole exchange under `timeout`.
    const bodyText = await readBodyWithLimit(response, MAX_RESPONSE_BYTES);

    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      text: () => Promise.resolve(bodyText),
      json: () => {
        try {
          return Promise.resolve(JSON.parse(bodyText) as unknown);
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    };
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
};

export const postToTv = (
  ip: string,
  endpoint: string,
  body: unknown,
  options: FetchOptions = {},
) =>
  fetchWithTimeout(
    buildUrl(ip, endpoint),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      body: JSON.stringify(body),
      dispatcher: httpsAgent,
    },
    options.timeout || 10000,
  );

export const getFromTv = (
  ip: string,
  endpoint: string,
  options: FetchOptions = {},
) =>
  fetchWithTimeout(
    buildUrl(ip, endpoint),
    {
      method: 'GET',
      headers: options.headers || {},
      dispatcher: httpsAgent,
    },
    options.timeout || 5000,
  );

/**
 * Open a TLS connection to the TV purely to read its certificate fingerprint.
 * Used at pairing time to capture the value that later connections pin to.
 */
export const fetchCertFingerprint = async (ip: string, timeout = 5000): Promise<string | null> => {
  let observed: string | null = null;
  const agent = createTvAgent({ onCertObserved: (fingerprint) => (observed = fingerprint) });

  try {
    await fetchWithTimeout(buildUrl(ip, '/system'), { method: 'GET', dispatcher: agent }, timeout);
  } catch {
    // A non-200 or a refused request is fine — the handshake is what matters,
    // and it has already run by the time the request itself fails.
  } finally {
    void agent.close();
  }

  return observed;
};

// ============================================================================
// DIGEST AUTHENTICATION
// ============================================================================

export const parseWwwAuthenticate = (header: string): DigestAuthParams => {
  const params: Record<string, string> = {};
  const regex = /(\w+)=(?:"([^"]*)"|([^,\s]*))/g;
  let match;

  while ((match = regex.exec(header)) !== null) {
    params[match[1]] = match[2] !== undefined ? match[2] : match[3];
  }

  return {
    realm: params.realm || '',
    nonce: params.nonce || '',
    qop: params.qop || '',
    opaque: params.opaque,
  };
};

export interface DigestHeaderParams {
  username: string;
  realm: string;
  nonce: string;
  qop: string;
  opaque?: string;
  /** Precomputed `md5(username:realm:password)`. */
  ha1: string;
  /** Nonce count for this use (1 for the first request on a nonce). */
  nc: number;
}

/**
 * Build a Digest `Authorization` header (RFC 7616, MD5) from already-known
 * challenge parameters. The single implementation behind both the cached
 * session (`DigestAuthSession`) and the one-shot `createDigestAuth`.
 */
export const buildDigestHeader = (params: DigestHeaderParams, method: string, uri: string): string => {
  const { username, realm, nonce, qop, opaque, ha1 } = params;
  const nc = params.nc.toString(16).padStart(8, '0');
  const cnonce = crypto.randomBytes(16).toString('hex');

  const ha2 = md5(`${method}:${uri}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);

  let header = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;

  if (qop) {
    header += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  }
  if (opaque) {
    header += `, opaque="${opaque}"`;
  }

  return header;
};

export const createDigestAuth = (
  username: string,
  password: string,
  wwwAuthHeader: string,
  method: string,
  uri: string,
): string => {
  const params = parseWwwAuthenticate(wwwAuthHeader);
  return buildDigestHeader(
    { ...params, username, ha1: md5(`${username}:${params.realm}:${password}`), nc: 1 },
    method,
    uri,
  );
};

// ============================================================================
// ERROR HANDLING
// ============================================================================

export const parseErrorResponse = (status: number, text?: string): string => {
  if (ERROR_MESSAGES[status]) {
    return ERROR_MESSAGES[status];
  }

  if (text?.includes('<html>')) {
    const titleMatch = text.match(/<title>([^<]+)<\/title>/i);
    const pMatch = text.match(/<p[^>]*>([^<]+)<\/p>/i);

    if (titleMatch?.[1] && titleMatch[1] !== 'Status page') {
      return titleMatch[1];
    }
    if (pMatch?.[1]) {
      return pMatch[1].trim();
    }
  }

  return `Request failed with status ${status}`;
};

export const handleErrorResponse = async (
  response: Awaited<ReturnType<typeof fetchWithTimeout>>,
  context: string,
): Promise<{ success: false; error: string }> => {
  const text = await response.text();
  const errorMessage = parseErrorResponse(response.status, text);
  console.log(`[${context}] Failed: ${response.status} - ${errorMessage}`);
  return { success: false, error: errorMessage };
};

// ============================================================================
// PAIRING UTILITIES
// ============================================================================

export const createDeviceInfo = (deviceName: string): DeviceInfo => {
  const deviceId = crypto.randomBytes(8).toString('hex');
  return {
    device_name: deviceName,
    device_os: 'Android',
    app_name: 'Homebridge Philips TV',
    type: 'native',
    app_id: `app.homebridge.philips.${deviceId}`,
    id: deviceId,
  };
};

export const createPairingSuccess = (session: PairingSession, certFingerprint?: string): {
  success: true;
  username: string;
  password: string;
  certFingerprint?: string;
  message: string;
} => ({
  success: true,
  username: session.device.id,
  password: session.auth_key,
  certFingerprint,
  message: 'Pairing successful!',
});

// ============================================================================
// DISCOVERY UTILITIES
// ============================================================================

export const extractIpv4 = (service: DiscoveredDevice): string => {
  const ipv4 = service.addresses?.find(addr => addr.includes('.') && !addr.includes(':'));
  return ipv4 || service.addresses?.[0] || service.host;
};

// ============================================================================
// STRING UTILITIES
// ============================================================================

/**
 * Strip control characters from TV-supplied text before it reaches the log.
 *
 * Resource names and error bodies arrive over a connection we cannot
 * authenticate (`httpsAgent` disables certificate verification because Philips
 * TVs use self-signed certs), so a newline in one would otherwise let the
 * device forge extra Homebridge log lines. The character class is written as
 * the negation of printable ranges so the pattern itself holds no control
 * characters.
 */
export const sanitizeForLog = (text: string, maxLength = 200): string => {
  const stripped = text.replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, ' ').replace(/\s+/g, ' ').trim();
  return stripped.length > maxLength ? `${stripped.slice(0, maxLength)}…` : stripped;
};

/** HAP's default maximum length for a string characteristic such as Name. */
export const HOMEKIT_NAME_MAX_LENGTH = 64;

/**
 * Sanitize a name for HomeKit compatibility.
 * HomeKit only allows alphanumeric, space, and apostrophe characters, and
 * rejects a Name longer than 64 characters.
 */
export const sanitizeForHomeKit = (name: string): string =>
  name
    .replace(/\+/g, ' Plus')
    .replace(/&/g, ' and ')
    .replace(/@/g, ' at ')
    .replace(/#/g, ' ')
    .replace(/[^a-zA-Z0-9 ']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^a-zA-Z0-9]+/, '')
    .replace(/[^a-zA-Z0-9]+$/, '')
    .slice(0, HOMEKIT_NAME_MAX_LENGTH)
    .replace(/[^a-zA-Z0-9]+$/, '')
    || 'Unknown';

/**
 * Clean a name a HomeKit controller wrote (a rename in the Home app) before it
 * is persisted or shown again: drop control characters and cap the length.
 *
 * Deliberately gentler than sanitizeForHomeKit — the controller has already
 * validated the name, and stripping to ASCII would mangle every accented or
 * non-Latin name a user chose ("Télé" → "T l").
 */
export const cleanControllerName = (name: string): string =>
  name.replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, '').replace(/\s+/g, ' ').trim().slice(0, HOMEKIT_NAME_MAX_LENGTH).trim();

// ============================================================================
// ADDRESS VALIDATION
// ============================================================================

/** True for a dotted-quad IPv4 address with every octet in range. */
export const isValidIpv4 = (ip: string): boolean => isIPv4(ip);

// ============================================================================
// MAC ADDRESSES
// ============================================================================

/** Bare 12-hex-digit form of a MAC, or null when the input is not one. */
export const macHexDigits = (mac: string): string | null => {
  const hex = mac.replace(/[:-]/g, '').toLowerCase();
  return /^[0-9a-f]{12}$/.test(hex) ? hex : null;
};

/**
 * Canonical spelling of a MAC: lowercase, colon-separated.
 *
 * Anything that derives a stable identity from a MAC has to agree on one
 * spelling, because the config accepts several: `AA:BB:CC:DD:EE:FF`,
 * `aa:bb:cc:dd:ee:ff` and `aa-bb-cc-dd-ee-ff` all name the same TV and all pass
 * validation. Re-detecting the address is enough to swap one for another — the
 * settings UI reads it from the OS ARP table, which prints lowercase, while an
 * address typed off the TV's network screen is usually uppercase.
 *
 * Returns the input untouched when it is not a MAC; validating that is the
 * caller's job.
 */
export const normalizeMacAddress = (mac: string): string => {
  const hex = macHexDigits(mac);
  return hex ? hex.match(/.{2}/g)!.join(':') : mac;
};

// ============================================================================
// WAKE-ON-LAN
// ============================================================================

const createMagicPacket = (mac: string): Buffer => {
  const macBuffer = Buffer.from(mac, 'hex');
  const packet = Buffer.alloc(102);
  packet.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) {
    macBuffer.copy(packet, 6 + i * 6);
  }
  return packet;
};

const wolSendPacket = (socket: dgram.Socket, packet: Buffer, address: string): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.send(packet, 0, packet.length, WOL_PORT, address, (err) =>
      err ? reject(err) : resolve(),
    );
  });

const wolSleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

const ipv4ToInt = (ip: string): number =>
  ip.split('.').reduce((acc, octet) => ((acc << 8) | parseInt(octet, 10)) >>> 0, 0);

const intToIpv4 = (n: number): string =>
  [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');

/**
 * Subnet-directed broadcast address of the local interface that shares a
 * subnet with `targetIp`, or null when none does.
 *
 * The limited broadcast (255.255.255.255) leaves through whichever interface
 * the OS picks — on a host with several networks, or in a container with a
 * bridge, that is often not the one the TV is on. A directed broadcast to the
 * TV's own subnet is routed out of the right interface.
 */
export const directedBroadcastFor = (
  targetIp: string,
  interfaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces(),
): string | null => {
  if (!isIPv4(targetIp)) {
    return null;
  }
  const target = ipv4ToInt(targetIp);
  for (const addresses of Object.values(interfaces)) {
    for (const iface of addresses ?? []) {
      if (iface.family !== 'IPv4' || iface.internal || !isIPv4(iface.netmask)) {
        continue;
      }
      const mask = ipv4ToInt(iface.netmask);
      const local = ipv4ToInt(iface.address);
      if ((local & mask) >>> 0 === (target & mask) >>> 0) {
        return intToIpv4(((local & mask) | (~mask >>> 0)) >>> 0);
      }
    }
  }
  return null;
};

/**
 * Send Wake-on-LAN magic packets in bursts (matching official Philips app).
 * Sends WOL_BURST_COUNT bursts of WOL_PACKETS_PER_BURST packets each,
 * with WOL_BURST_INTERVAL_MS between bursts — to the limited broadcast and,
 * when the TV's IP is known, to its subnet's directed broadcast as well.
 */
export const sendWakeOnLan = (macAddress: string, targetIp?: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const mac = macHexDigits(macAddress);

    if (!mac) {
      return reject(new Error('Invalid MAC address format'));
    }

    const directed = targetIp ? directedBroadcastFor(targetIp) : null;
    const addresses = directed && directed !== WOL_BROADCAST_IP ? [WOL_BROADCAST_IP, directed] : [WOL_BROADCAST_IP];

    const socket = dgram.createSocket('udp4');
    const packet = createMagicPacket(mac);

    socket.once('error', (err) => {
      socket.close();
      reject(err);
    });

    socket.bind(async () => {
      socket.setBroadcast(true);
      try {
        for (let burst = 0; burst < WOL_BURST_COUNT; burst++) {
          for (let i = 0; i < WOL_PACKETS_PER_BURST; i++) {
            for (const address of addresses) {
              await wolSendPacket(socket, packet, address);
            }
          }
          if (burst < WOL_BURST_COUNT - 1) {
            await wolSleep(WOL_BURST_INTERVAL_MS);
          }
        }
        socket.close();
        resolve();
      } catch (err) {
        socket.close();
        reject(err);
      }
    });
  });
