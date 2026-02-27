/**
 * Philips TV API Utilities
 */

import crypto from 'crypto';
import dgram from 'dgram';
import { Agent, type Dispatcher, fetch } from 'undici';
import {
  TV_API_PORT, TV_API_VERSION, ERROR_MESSAGES, AUTH_SHARED_KEY,
  WOL_PORT, WOL_BROADCAST_IP, WOL_BURST_COUNT, WOL_PACKETS_PER_BURST, WOL_BURST_INTERVAL_MS,
} from './constants.js';
import type { DeviceInfo, DigestAuthParams, FetchOptions, PairingSession, DiscoveredDevice } from './types.js';

// ============================================================================
// HTTPS AGENT
// ============================================================================

export const httpsAgent: Dispatcher = new Agent({
  connect: { rejectUnauthorized: false },
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 30_000,
});

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

export const fetchWithTimeout = async (
  url: string,
  options: { method: string; headers?: Record<string, string>; body?: string; dispatcher?: Dispatcher },
  timeout: number,
  externalSignal?: AbortSignal,
) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  // If an external signal is provided, abort our controller when it fires
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      dispatcher: options.dispatcher || httpsAgent,
    });
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

export const createDigestAuth = (
  username: string,
  password: string,
  wwwAuthHeader: string,
  method: string,
  uri: string,
): string => {
  const { realm, nonce, qop, opaque } = parseWwwAuthenticate(wwwAuthHeader);
  const cnonce = crypto.randomBytes(16).toString('hex');
  const nc = '00000001';

  const ha1 = md5(`${username}:${realm}:${password}`);
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

export const createPairingSuccess = (session: PairingSession): {
  success: true;
  username: string;
  password: string;
  message: string;
} => ({
  success: true,
  username: session.device.id,
  password: session.auth_key,
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
 * Sanitize a name for HomeKit compatibility.
 * HomeKit only allows alphanumeric, space, and apostrophe characters.
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
    || 'Unknown';

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

const wolSendPacket = (socket: dgram.Socket, packet: Buffer): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.send(packet, 0, packet.length, WOL_PORT, WOL_BROADCAST_IP, (err) =>
      err ? reject(err) : resolve(),
    );
  });

const wolSleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/**
 * Send Wake-on-LAN magic packets in bursts (matching official Philips app).
 * Sends WOL_BURST_COUNT bursts of WOL_PACKETS_PER_BURST packets each,
 * with WOL_BURST_INTERVAL_MS between bursts.
 */
export const sendWakeOnLan = (macAddress: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const mac = macAddress.replace(/[:-]/g, '').toLowerCase();

    if (mac.length !== 12 || !/^[0-9a-f]+$/.test(mac)) {
      return reject(new Error('Invalid MAC address format'));
    }

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
            await wolSendPacket(socket, packet);
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
