import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils';
import { Bonjour } from 'bonjour-service';
import arp from 'node-arp';
import { promisify } from 'util';

import {
  TV_API_PORT,
  TV_API_VERSION,
  DISCOVERY_TIMEOUT,
  CONNECTION_TIMEOUT,
} from './api/constants.js';
import {
  hmacSignature,
  postToTv,
  getFromTv,
  createDigestAuth,
  createDeviceInfo,
  handleErrorResponse,
  extractIpv4,
  createPairingSuccess,
  sendWakeOnLan,
} from './api/utils.js';
import { PhilipsTVClient, WATCH_TV_URI } from './api/PhilipsTVClient.js';

const getMAC = promisify(arp.getMAC);

// ============================================================================
// UI SERVER CLASS
// ============================================================================

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.pairingSessions = new Map();

    // Register request handlers
    this.onRequest('/discover', this.discoverDevices.bind(this));
    this.onRequest('/test-connection', this.testConnection.bind(this));
    this.onRequest('/get-mac', this.getMacAddress.bind(this));
    this.onRequest('/wake-on-lan', this.wakeOnLan.bind(this));
    this.onRequest('/pair', this.pair.bind(this));
    this.onRequest('/pair-grant', this.pairGrant.bind(this));
    this.onRequest('/system-info', this.getSystemInfo.bind(this));
    this.onRequest('/get-sources', this.getSources.bind(this));

    this.ready();
  }

  // --------------------------------------------------------------------------
  // Discovery
  // --------------------------------------------------------------------------

  async discoverDevices() {
    return new Promise((resolve) => {
      const devices = [];
      const bonjour = new Bonjour();
      const browser = bonjour.find({ type: 'androidtvremote2' });

      browser.on('up', (service) => {
        const device = {
          name: service.name,
          host: extractIpv4(service),
          addresses: service.addresses || [],
          port: service.port,
          txt: service.txt,
          type: service.type,
        };

        if (!devices.some(d => d.host === device.host)) {
          devices.push(device);
        }
      });

      setTimeout(() => {
        browser.stop();
        bonjour.destroy();
        resolve(devices);
      }, DISCOVERY_TIMEOUT);
    });
  }

  // --------------------------------------------------------------------------
  // Connection Testing
  // --------------------------------------------------------------------------

  async testConnection(ipAddress) {
    try {
      console.log(`[Test] Testing connection to ${ipAddress}`);

      const response = await getFromTv(ipAddress, '/system', { timeout: CONNECTION_TIMEOUT });
      console.log(`[Test] Response status: ${response.status}`);

      if (response.ok || response.status === 401) {
        return { success: true, message: 'TV is reachable and API is accessible' };
      }

      return { success: false, error: `TV responded with status ${response.status}` };
    } catch (error) {
      console.log('[Test] Connection test failed:', error.message);
      return {
        success: false,
        error: `Cannot reach TV at ${ipAddress}:${TV_API_PORT}. Please check:\n1) TV is powered on\n2) TV is connected to the same network`,
        details: error.message,
      };
    }
  }

  // --------------------------------------------------------------------------
  // MAC Address
  // --------------------------------------------------------------------------

  async getMacAddress(ipAddress) {
    try {
      const mac = await getMAC(ipAddress);
      return { success: true, mac };
    } catch (error) {
      return { success: false, error: error.message || 'Failed to get MAC address' };
    }
  }

  // --------------------------------------------------------------------------
  // Wake-on-LAN
  // --------------------------------------------------------------------------

  async wakeOnLan(data) {
    const { mac } = data;

    if (!mac) {
      return { success: false, error: 'MAC address is required' };
    }

    try {
      console.log(`[WOL] Sending magic packet to ${mac}`);
      await sendWakeOnLan(mac);
      console.log('[WOL] Magic packet sent successfully');
      return { success: true, message: 'Wake-on-LAN packet sent' };
    } catch (error) {
      console.log('[WOL] Failed:', error.message);
      return { success: false, error: error.message || 'Failed to send Wake-on-LAN packet' };
    }
  }

  // --------------------------------------------------------------------------
  // Pairing - Step 1: Request
  // --------------------------------------------------------------------------

  async pair(data) {
    const { ip, deviceName = 'Homebridge' } = data;

    if (!ip) {
      return { success: false, error: 'IP address is required' };
    }

    try {
      console.log(`[Pairing] Starting pairing with TV at ${ip}`);

      const testResult = await this.testConnection(ip);
      if (!testResult.success) {
        return testResult;
      }

      console.log('[Pairing] Connection test passed, proceeding with pairing...');

      const device = createDeviceInfo(deviceName);
      const pairRequest = {
        access: { scope: ['read', 'write', 'control'] },
        device,
      };

      console.log('[Pairing] Sending pairing request...');

      const response = await postToTv(ip, '/pair/request', pairRequest);

      if (!response.ok) {
        return handleErrorResponse(response, 'Pairing');
      }

      const result = await response.json();

      this.pairingSessions.set(ip, {
        auth_key: result.auth_key,
        timestamp: result.timestamp,
        device,
      });

      return {
        success: true,
        auth_key: result.auth_key,
        timestamp: result.timestamp,
        message: 'Check your TV screen for the PIN code',
      };
    } catch (error) {
      console.log('[Pairing] Error:', error.message);
      return { success: false, error: error.message || 'Failed to initiate pairing' };
    }
  }

  // --------------------------------------------------------------------------
  // Pairing - Step 2: Grant (with PIN)
  // --------------------------------------------------------------------------

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
      console.log('[PairGrant] Processing PIN...');

      const signature = hmacSignature(session.timestamp.toString(), pin);

      const grantRequest = {
        auth: {
          auth_appId: '1',
          auth_timestamp: session.timestamp,
          auth_signature: signature,
          pin,
        },
        device: session.device,
      };

      const initialResponse = await postToTv(ip, '/pair/grant', grantRequest, { timeout: CONNECTION_TIMEOUT });

      if (initialResponse.status === 401) {
        const wwwAuth = initialResponse.headers.get('www-authenticate');

        if (wwwAuth?.toLowerCase().startsWith('digest')) {
          console.log('[PairGrant] Retrying with Digest auth...');

          const digestAuth = createDigestAuth(
            session.device.id,
            session.auth_key,
            wwwAuth,
            'POST',
            `/${TV_API_VERSION}/pair/grant`,
          );

          const response = await postToTv(ip, '/pair/grant', grantRequest, {
            headers: { 'Authorization': digestAuth },
            timeout: CONNECTION_TIMEOUT,
          });

          if (!response.ok) {
            return handleErrorResponse(response, 'PairGrant');
          }

          const result = await response.json();

          if (result.error_id && result.error_id !== 'SUCCESS') {
            return { success: false, error: `Pairing failed: ${result.error_id} - ${result.error_text || ''}` };
          }

          this.pairingSessions.delete(ip);
          return createPairingSuccess(session);
        }
      }

      if (!initialResponse.ok) {
        return handleErrorResponse(initialResponse, 'PairGrant');
      }

      this.pairingSessions.delete(ip);
      return createPairingSuccess(session);
    } catch (error) {
      console.log('[PairGrant] Error:', error.message);
      return { success: false, error: error.message || 'Failed to complete pairing' };
    }
  }

  // --------------------------------------------------------------------------
  // System Info
  // --------------------------------------------------------------------------

  async getSystemInfo(data) {
    const { ip, username, password } = data;

    if (!ip) {
      return { success: false, error: 'IP address is required' };
    }

    try {
      console.log(`[SystemInfo] Getting system info from ${ip}`);

      const initialResponse = await getFromTv(ip, '/system');

      if (initialResponse.status === 401 && username && password) {
        const wwwAuth = initialResponse.headers.get('www-authenticate');

        if (wwwAuth?.toLowerCase().startsWith('digest')) {
          const digestAuth = createDigestAuth(username, password, wwwAuth, 'GET', `/${TV_API_VERSION}/system`);

          const response = await getFromTv(ip, '/system', {
            headers: { 'Authorization': digestAuth },
          });

          if (response.ok) {
            const systemInfo = await response.json();
            console.log('[SystemInfo] Retrieved successfully');
            return { success: true, data: systemInfo };
          }
        }
      }

      if (initialResponse.ok) {
        const systemInfo = await initialResponse.json();
        console.log('[SystemInfo] Retrieved successfully');
        return { success: true, data: systemInfo };
      }

      return { success: false, error: `Failed to get system info: ${initialResponse.status}` };
    } catch (error) {
      console.log('[SystemInfo] Error:', error.message);
      return { success: false, error: error.message || 'Failed to get system information' };
    }
  }

  // --------------------------------------------------------------------------
  // Get Sources (HDMI + Apps)
  // --------------------------------------------------------------------------

  async getSources(data) {
    const { ip, username, password, mac } = data;

    if (!ip) {
      return { success: false, error: 'IP address is required' };
    }

    try {
      console.log(`[Sources] Getting sources from ${ip}`);

      // Create PhilipsTVClient instance
      const client = new PhilipsTVClient({
        ip,
        mac: mac || '',
        username: username || '',
        password: password || '',
      });

      // Fetch sources from TV API (async call)
      let tvSources = [];
      try {
        tvSources = await client.getSources();
        console.log(`[Sources] Fetched ${tvSources.length} sources from TV API`);
      } catch (sourceError) {
        console.log('[Sources] Could not fetch sources from TV, using built-in:', sourceError.message);
        tvSources = client.getBuiltInSources();
      }

      // Convert TV sources to UI format
      const builtInSources = tvSources.map(source => ({
        id: source.id,
        name: source.name,
        type: 'source',
        icon: source.id === WATCH_TV_URI ? 'tv' : 'hdmi',
      }));

      // Try to get apps from TV using the client
      let apps = [];
      try {
        apps = await client.getApplications();
      } catch (appError) {
        console.log('[Sources] Could not fetch apps:', appError.message);
      }

      // If no apps from TV, use fallback apps
      if (apps.length === 0) {
        apps = [
          { label: 'Home', intent: { component: { packageName: 'com.google.android.tvlauncher' } } },
          { label: 'YouTube', intent: { component: { packageName: 'com.google.android.youtube.tv' } } },
          { label: 'Netflix', intent: { component: { packageName: 'com.netflix.ninja' } } },
          { label: 'Disney+', intent: { component: { packageName: 'com.disney.disneyplus' } } },
          { label: 'Prime Video', intent: { component: { packageName: 'com.amazon.amazonvideo.livingroom' } } },
        ];
      }

      // Convert apps to source format
      const appSources = apps.slice(0, 10).map(app => ({
        id: app.intent?.component?.packageName || app.id || app.label,
        name: app.label || app.name || 'Unknown App',
        type: 'app',
        icon: 'app',
      }));

      const sources = [...builtInSources, ...appSources];

      console.log(`[Sources] Found ${sources.length} sources (${builtInSources.length} built-in, ${appSources.length} apps)`);

      return { success: true, sources };
    } catch (error) {
      console.log('[Sources] Error:', error.message);
      return { success: false, error: error.message || 'Failed to get sources' };
    }
  }
}

// ============================================================================
// BOOTSTRAP
// ============================================================================

(() => new UiServer())();
