import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils';
import { Bonjour } from 'bonjour-service';
import arp from 'node-arp';
import { promisify } from 'util';
import fetch from 'node-fetch';
import crypto from 'crypto';
import https from 'https';

const getMAC = promisify(arp.getMAC);

// Philips TV shared secret key for signature verification
// This is a known constant from the Philips TV API (from ha-philipsjs)
const AUTH_SHARED_KEY = Buffer.from(
  'ZmVay1EQVFOaZhwQ4Kv81ypLAZNczV9sG4KkseXWn1NEk6cXmPKO/MCa9sryslvLCFMnNe4Z4CPXzToowvhHvA==',
  'base64',
);

/**
 * Calculate HMAC-SHA1 signature for pairing
 * Based on ha-philipsjs implementation: base64(binary_digest)
 * @param {Buffer} key - Shared secret key
 * @param {string} timestamp - Timestamp from pair request
 * @param {string} pin - PIN code from TV
 * @returns {string} Base64 encoded signature
 */
function hmacSignature(key, timestamp, pin) {
  const hmac = crypto.createHmac('sha1', key);
  hmac.update(timestamp);
  hmac.update(pin);
  return hmac.digest('base64');
}

// HTTPS agent that ignores certificate errors (TV uses self-signed certs)
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

/**
 * Parse error response and return user-friendly message
 * @param {number} status - HTTP status code
 * @param {string} text - Response text (may contain HTML)
 * @returns {string} User-friendly error message
 */
function parseErrorResponse(status, text) {
  // Map common HTTP errors to user-friendly messages
  const errorMessages = {
    401: 'Invalid PIN code. Please check the PIN on your TV screen and try again.',
    403: 'Access denied. The TV rejected the pairing request.',
    404: 'Pairing endpoint not found. Your TV may not support this pairing method.',
    408: 'Request timeout. The TV took too long to respond.',
    500: 'TV internal error. Please try again.',
    503: 'TV is temporarily unavailable. Please try again later.',
  };

  // Check if we have a specific message for this status
  if (errorMessages[status]) {
    return errorMessages[status];
  }

  // Try to extract meaningful text from HTML response
  if (text && text.includes('<html>')) {
    // Try to extract the title or first paragraph
    const titleMatch = text.match(/<title>([^<]+)<\/title>/i);
    const pMatch = text.match(/<p[^>]*>([^<]+)<\/p>/i);

    if (titleMatch && titleMatch[1] && titleMatch[1] !== 'Status page') {
      return titleMatch[1];
    }
    if (pMatch && pMatch[1]) {
      return pMatch[1].trim();
    }
  }

  // Return generic message with status code
  return `Request failed with status ${status}`;
}

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.pairingSessions = new Map(); // Store pairing sessions
    this.onRequest('/pair', this.pair.bind(this));
    this.onRequest('/pair-grant', this.pairGrant.bind(this));
    this.onRequest('/discover', this.discoverDevices.bind(this));
    this.onRequest('/get-mac', this.getMacAddress.bind(this));
    this.onRequest('/test-connection', this.testConnection.bind(this));
    this.ready();
  }

  /**
   * Start pairing with the TV
   * JointSpace API v6 pairing process:
   * 1. Send POST to /6/pair/request with device info
   * 2. TV shows PIN on screen
   * 3. User enters PIN and we send POST to /6/pair/grant with auth
   */
  async pair(data) {
    const { ip, deviceName = 'Homebridge' } = data;

    if (!ip) {
      return { success: false, error: 'IP address is required' };
    }

    try {
      console.log(`[Pairing] Starting pairing with TV at ${ip}`);

      // Test connection first
      const testResult = await this.testConnection(ip);
      if (!testResult.success) {
        return {
          success: false,
          error: testResult.error,
        };
      }

      console.log('[Pairing] Connection test passed, proceeding with pairing...');

      // Generate random device ID
      const deviceId = crypto.randomBytes(8).toString('hex');

      const device = {
        device_name: deviceName,
        device_os: 'Android',
        app_name: 'Homebridge Philips TV',
        type: 'native',
        app_id: `app.homebridge.philips.${deviceId}`,
        id: deviceId,
      };

      const pairRequest = {
        access: {
          scope: ['read', 'write', 'control'],
        },
        device: device,
      };

      console.log('[Pairing] Sending pairing request to TV...');
      console.log('[Pairing] Request payload:', JSON.stringify(pairRequest, null, 2));

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout

      const response = await fetch(`https://${ip}:1926/6/pair/request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(pairRequest),
        agent: httpsAgent,
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      if (!response.ok) {
        const text = await response.text();
        return {
          success: false,
          error: `Pairing request failed: ${response.status} - ${text}`,
        };
      }

      const result = await response.json();

      // Store pairing session with full device object
      this.pairingSessions.set(ip, {
        auth_key: result.auth_key,
        timestamp: result.timestamp,
        device: device,
      });

      return {
        success: true,
        auth_key: result.auth_key,
        timestamp: result.timestamp,
        message: 'Check your TV screen for the PIN code',
      };
    } catch (error) {
      return {
        success: false,
        error: error.message || 'Failed to initiate pairing',
      };
    }
  }

  /**
   * Complete pairing by sending the PIN shown on TV
   */
  async pairGrant(data) {
    const { ip, pin } = data;

    if (!ip || !pin) {
      return { success: false, error: 'IP address and PIN are required' };
    }

    const session = this.pairingSessions.get(ip);
    if (!session) {
      return { success: false, error: 'No active pairing session found' };
    }

    try {
      console.log('[PairGrant] Calculating HMAC signature...');
      // Calculate signature using shared key, timestamp and PIN
      const signature = hmacSignature(AUTH_SHARED_KEY, session.timestamp.toString(), pin);
      console.log('[PairGrant] Signature calculated');

      // Use exact structure from ha-philipsjs with same device from pair request
      const grantRequest = {
        auth: {
          auth_appId: '1',
          auth_timestamp: session.timestamp,
          auth_signature: signature,
          pin: pin,
        },
        device: session.device,
      };

      console.log('[PairGrant] Sending grant request with Digest Auth...');
      console.log('[PairGrant] Request payload:', JSON.stringify(grantRequest, null, 2));

      // First request to get digest challenge
      const initialResponse = await fetch(`https://${ip}:1926/6/pair/grant`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(grantRequest),
        agent: httpsAgent,
      });

      // Check if we got a 401 with Digest challenge
      if (initialResponse.status === 401) {
        const wwwAuth = initialResponse.headers.get('www-authenticate');
        console.log('[PairGrant] Got digest challenge:', wwwAuth);

        if (wwwAuth && wwwAuth.toLowerCase().startsWith('digest')) {
          // Parse digest challenge
          const digestAuth = this.createDigestAuth(
            session.device.id,
            session.auth_key,
            wwwAuth,
            'POST',
            '/6/pair/grant',
          );

          console.log('[PairGrant] Retrying with Digest auth...');
          const response = await fetch(`https://${ip}:1926/6/pair/grant`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': digestAuth,
            },
            body: JSON.stringify(grantRequest),
            agent: httpsAgent,
          });

          if (!response.ok) {
            const text = await response.text();
            console.error(`[PairGrant] Grant failed: ${response.status} - ${text}`);
            const errorMessage = parseErrorResponse(response.status, text);
            return {
              success: false,
              error: errorMessage,
            };
          }

          const result = await response.json();
          console.log('[PairGrant] Grant response:', result);

          if (result.error_id && result.error_id !== 'SUCCESS') {
            return {
              success: false,
              error: `Pairing failed: ${result.error_id} - ${result.error_text || ''}`,
            };
          }

          // Pairing successful, clean up session
          this.pairingSessions.delete(ip);

          return {
            success: true,
            username: session.device.id,
            password: session.auth_key,
            message: 'Pairing successful!',
          };
        }
      }

      // Handle non-401 responses
      if (!initialResponse.ok) {
        const text = await initialResponse.text();
        const errorMessage = parseErrorResponse(initialResponse.status, text);
        console.error(`[PairGrant] Unexpected response: ${initialResponse.status} - ${errorMessage}`);
        return {
          success: false,
          error: errorMessage,
        };
      }

      // Success without digest auth (shouldn't happen but handle it)
      const result = await initialResponse.json();
      this.pairingSessions.delete(ip);

      return {
        success: true,
        username: session.device.id,
        password: session.auth_key,
        message: 'Pairing successful!',
      };
    } catch (error) {
      console.error('[PairGrant] Error:', error);
      return {
        success: false,
        error: error.message || 'Failed to complete pairing',
      };
    }
  }

  /**
   * Create HTTP Digest Authentication header
   */
  createDigestAuth(username, password, wwwAuthHeader, method, uri) {
    // Parse the WWW-Authenticate header
    const authParams = {};
    // Match key="value" or key=value patterns, handling = inside quoted values
    const regex = /(\w+)=(?:"([^"]*)"|([^,\s]*))/g;
    let match;

    while ((match = regex.exec(wwwAuthHeader)) !== null) {
      const key = match[1];
      const value = match[2] !== undefined ? match[2] : match[3];
      authParams[key] = value;
    }

    const realm = authParams.realm || '';
    const nonce = authParams.nonce || '';
    const qop = authParams.qop || '';
    const opaque = authParams.opaque;

    // Generate client nonce
    const cnonce = crypto.randomBytes(16).toString('hex');
    const nc = '00000001';

    // Calculate HA1
    const ha1 = crypto.createHash('md5')
      .update(`${username}:${realm}:${password}`)
      .digest('hex');

    // Calculate HA2
    const ha2 = crypto.createHash('md5')
      .update(`${method}:${uri}`)
      .digest('hex');

    // Calculate response
    let response;
    if (qop === 'auth' || qop === 'auth-int') {
      response = crypto.createHash('md5')
        .update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
        .digest('hex');
    } else {
      response = crypto.createHash('md5')
        .update(`${ha1}:${nonce}:${ha2}`)
        .digest('hex');
    }

    // Build authorization header
    let authHeader = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;

    if (qop) {
      authHeader += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
    }

    if (opaque) {
      authHeader += `, opaque="${opaque}"`;
    }

    return authHeader;
  }

  async discoverDevices() {
    return new Promise((resolve) => {
      const devices = [];
      const bonjour = new Bonjour();

      // Search for Android TV devices - they typically advertise as _androidtvremote2._tcp
      const browser = bonjour.find({ type: 'androidtvremote2' });

      browser.on('up', (service) => {
        // Prefer IP address over hostname to avoid .local addresses
        let ipAddress = null;

        // Try to get IPv4 address from addresses array
        if (service.addresses && service.addresses.length > 0) {
          // Filter for IPv4 addresses (not IPv6)
          const ipv4Addresses = service.addresses.filter(addr =>
            addr.includes('.') && !addr.includes(':'),
          );
          ipAddress = ipv4Addresses[0] || service.addresses[0];
        }

        // Fallback to referer address or host
        if (!ipAddress) {
          ipAddress = service.referer?.address || service.host;
        }

        const device = {
          name: service.name,
          host: ipAddress,
          addresses: service.addresses || [],
          port: service.port,
          txt: service.txt,
          type: service.type,
        };

        // Add device if not already in list (check by IP)
        if (!devices.some(d => d.host === device.host)) {
          devices.push(device);
        }
      });

      // Stop searching after 5 seconds
      // eslint-disable-next-line no-undef
      setTimeout(() => {
        browser.stop();
        bonjour.destroy();
        resolve(devices);
      }, 5000);
    });
  }

  async getMacAddress(ipAddress) {
    try {
      const mac = await getMAC(ipAddress);
      return { success: true, mac };
    } catch (error) {
      return {
        success: false,
        error: error.message || 'Failed to get MAC address',
      };
    }
  }

  async testConnection(ipAddress) {
    try {
      console.log(`[Test] Testing connection to ${ipAddress}:1926`);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000); // 5 second timeout

      // Try to get system info from TV
      const response = await fetch(`https://${ipAddress}:1926/6/system`, {
        method: 'GET',
        agent: httpsAgent,
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      console.log(`[Test] Response status: ${response.status}`);

      if (response.ok || response.status === 401) {
        // 401 is expected if not paired yet, but means API is accessible
        return {
          success: true,
          message: 'TV is reachable and API is accessible',
        };
      }

      return {
        success: false,
        error: `TV responded with status ${response.status}`,
      };
    } catch (error) {
      console.error('[Test] Connection test failed:', error.message);
      return {
        success: false,
        error:
          `Cannot reach TV at ${ipAddress}:1926.\n\n` +
          'Please check:\n' +
          '1) TV is powered on\n' +
          '2) TV is connected to the same network',
        details: error.message,
      };
    }
  }

  async getSystemInfo(data) {
    const { ip, username, password } = data;

    if (!ip) {
      return { success: false, error: 'IP address is required' };
    }

    try {
      console.log(`[SystemInfo] Getting system info from ${ip}`);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      // First request to get digest challenge
      const initialResponse = await fetch(`https://${ip}:1926/6/system`, {
        method: 'GET',
        agent: httpsAgent,
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      // If we have credentials and got a 401, use digest auth
      if (initialResponse.status === 401 && username && password) {
        const wwwAuth = initialResponse.headers.get('www-authenticate');

        if (wwwAuth && wwwAuth.toLowerCase().startsWith('digest')) {
          const digestAuth = this.createDigestAuth(
            username,
            password,
            wwwAuth,
            'GET',
            '/6/system',
          );

          const response = await fetch(`https://${ip}:1926/6/system`, {
            method: 'GET',
            headers: {
              'Authorization': digestAuth,
            },
            agent: httpsAgent,
          });

          if (response.ok) {
            const systemInfo = await response.json();
            console.log('[SystemInfo] Retrieved:', systemInfo);
            return {
              success: true,
              data: systemInfo,
            };
          }
        }
      }

      // If no auth needed or available
      if (initialResponse.ok) {
        const systemInfo = await initialResponse.json();
        console.log('[SystemInfo] Retrieved:', systemInfo);
        return {
          success: true,
          data: systemInfo,
        };
      }

      return {
        success: false,
        error: `Failed to get system info: ${initialResponse.status}`,
      };
    } catch (error) {
      console.error('[SystemInfo] Error:', error);
      return {
        success: false,
        error: error.message || 'Failed to get system information',
      };
    }
  }
}

(() => {
  return new UiServer();
})();
