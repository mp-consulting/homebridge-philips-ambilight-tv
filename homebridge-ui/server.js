import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils';
import { Bonjour } from 'bonjour-service';
import arp from 'node-arp';
import { isIPv4 } from 'net';
import { promisify } from 'util';

import {
  TV_API_VERSION,
  DISCOVERY_TIMEOUT,
  CONNECTION_TIMEOUT,
  PAIRING_TIMEOUT,
} from '../dist/api/constants.js';
import {
  buildUrl,
  hmacSignature,
  macHexDigits,
  normalizeMacAddress,
  fetchWithTimeout,
  createTvAgent,
  createDigestAuth,
  createDeviceInfo,
  handleErrorResponse,
  extractIpv4,
  createPairingSuccess,
  sanitizeForLog,
  sendWakeOnLan,
} from '../dist/api/utils.js';
import { PhilipsTVClient, HOME_URI, WATCH_TV_URI } from '../dist/api/PhilipsTVClient.js';
import { isSystemForegroundPackage } from '../dist/services/inputs/constants.js';
import { registerAssistant } from './assistant.js';

const getMAC = promisify(arp.getMAC);

// ============================================================================
// CONSTANTS
// ============================================================================

/** How long a pairing request stays valid waiting for its PIN. The TV shows
 *  the PIN for well under this; anything older is abandoned. */
export const PAIRING_SESSION_TTL_MS = 5 * 60_000;

/** Upper bound on concurrent pairing sessions, so repeated requests for
 *  arbitrary addresses cannot grow the map without limit. */
export const MAX_PAIRING_SESSIONS = 16;

/** node-arp shells out to ping/arp and never answers on some platforms. */
const MAC_LOOKUP_DEADLINE_MS = 8000;

/** Per-request timeout for the setup wizard, which is not bound by HomeKit's
 *  callback deadline and so can give a slow TV a longer chance. */
const WIZARD_REQUEST_TIMEOUT_MS = 6000;

/** Hard ceiling on fetching sources + apps combined. */
const WIZARD_TOTAL_DEADLINE_MS = 15000;

const INVALID_IP_ERROR = 'A valid IPv4 address is required';

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Races a promise against an overall deadline. If the deadline passes first,
 * the returned promise rejects so the caller can fall back — guaranteeing a
 * bounded response even if the underlying work never settles. The timer is
 * unref'd so it never keeps the process alive on its own.
 */
export function withDeadline(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${ms}ms`));
    }, ms);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * The IP must be a plain dotted quad before it is used anywhere: it is
 * interpolated into `https://${ip}:1926/...` (a value like `host/x?#` would
 * point the request at any host and path) and handed to ping/arp, where a
 * value starting with `-` would be read as an option.
 */
const isValidIp = (ip) => typeof ip === 'string' && isIPv4(ip);

/**
 * Verbose per-request logging. Config UI X streams the UI server's stdout to
 * the browser over socket.io, and each line is an event it relays to the plugin
 * iframe — so chatty handlers add load to the same channel that delivers request
 * responses. Routine progress lines are gated behind this flag (set
 * PHILIPS_TV_UI_DEBUG=1) so the default path stays quiet; errors and the final
 * summary are always logged.
 */
const UI_DEBUG = process.env.PHILIPS_TV_UI_DEBUG === '1' || process.env.PHILIPS_TV_UI_DEBUG === 'true';
function debugLog(...args) {
  if (UI_DEBUG) {
    console.log(...args);
  }
}

// ============================================================================
// UI SERVER CLASS
// ============================================================================

export class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    /** ip → { auth_key, timestamp, device, certFingerprint, agent, expiresAt } */
    this.pairingSessions = new Map();

    // Register request handlers
    this.onRequest('/discover', this.discoverDevices.bind(this));
    this.onRequest('/get-mac', this.getMacAddress.bind(this));
    this.onRequest('/wake-on-lan', this.wakeOnLan.bind(this));
    this.onRequest('/pair', this.pair.bind(this));
    this.onRequest('/pair-grant', this.pairGrant.bind(this));
    this.onRequest('/get-sources', this.getSources.bind(this));
    this.onRequest('/current-app', this.getCurrentApp.bind(this));

    // Assistant: /ai/status, /ai/explain, /ai/ask, /ai/config (configured in Homebridge AI Kit)
    registerAssistant(this);

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
  // MAC Address
  // --------------------------------------------------------------------------

  async getMacAddress(ipAddress) {
    if (!isValidIp(ipAddress)) {
      return { success: false, error: INVALID_IP_ERROR };
    }
    try {
      // Canonicalize before it reaches the config: the ARP table prints
      // lowercase while an address typed off the TV is usually uppercase, and
      // writing back a differently-spelled version of the same address used to
      // republish the TV as a new, unpaired HomeKit accessory.
      const raw = await withDeadline(getMAC(ipAddress), MAC_LOOKUP_DEADLINE_MS);
      if (typeof raw !== 'string' || !macHexDigits(raw)) {
        return { success: false, error: 'No MAC address found for that IP. Make sure the TV is on.' };
      }
      return { success: true, mac: normalizeMacAddress(raw) };
    } catch (error) {
      return { success: false, error: error.message || 'Failed to get MAC address' };
    }
  }

  // --------------------------------------------------------------------------
  // Wake-on-LAN
  // --------------------------------------------------------------------------

  async wakeOnLan(data) {
    const mac = data?.mac;
    // Optional: lets the packet also go to the TV's subnet broadcast.
    const ip = isValidIp(data?.ip) ? data.ip : undefined;

    if (typeof mac !== 'string' || !macHexDigits(mac)) {
      return { success: false, error: 'A valid MAC address is required' };
    }

    try {
      debugLog(`[WOL] Sending magic packet to ${mac}`);
      await sendWakeOnLan(mac, ip);
      return { success: true, message: 'Wake-on-LAN packet sent' };
    } catch (error) {
      console.log('[WOL] Failed:', error.message);
      return { success: false, error: error.message || 'Failed to send Wake-on-LAN packet' };
    }
  }

  // --------------------------------------------------------------------------
  // Pairing sessions
  // --------------------------------------------------------------------------

  /** Forget a session and release its pooled connections. */
  dropPairingSession(ip) {
    const session = this.pairingSessions.get(ip);
    if (session) {
      this.pairingSessions.delete(ip);
      void session.agent.close().catch(() => {});
    }
  }

  purgeExpiredPairingSessions(now = Date.now()) {
    for (const [ip, session] of this.pairingSessions) {
      if (session.expiresAt <= now) {
        this.dropPairingSession(ip);
      }
    }
  }

  /** Store a session, evicting the oldest when the cap is reached. */
  storePairingSession(ip, session) {
    this.purgeExpiredPairingSessions();
    this.dropPairingSession(ip);
    while (this.pairingSessions.size >= MAX_PAIRING_SESSIONS) {
      this.dropPairingSession(this.pairingSessions.keys().next().value);
    }
    this.pairingSessions.set(ip, session);
  }

  // --------------------------------------------------------------------------
  // Pairing - Step 1: Request
  // --------------------------------------------------------------------------

  async pair(data) {
    const { ip, deviceName = 'Homebridge' } = data ?? {};

    if (!isValidIp(ip)) {
      return { success: false, error: INVALID_IP_ERROR };
    }

    // The certificate is recorded on the very connection that carries the
    // pairing request, so the grant (and every later connection) can be held
    // to it — not read on a separate connection after the fact.
    let observed = null;
    const agent = createTvAgent({ onCertObserved: (fingerprint) => (observed = fingerprint) });

    try {
      console.log(`[Pairing] Starting pairing with TV at ${ip}`);

      const device = createDeviceInfo(String(deviceName).slice(0, 64));
      const pairRequest = {
        access: { scope: ['read', 'write', 'control'] },
        device,
      };

      let response;
      try {
        response = await fetchWithTimeout(
          buildUrl(ip, '/pair/request'),
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pairRequest), dispatcher: agent },
          PAIRING_TIMEOUT,
        );
      } catch (error) {
        void agent.close().catch(() => {});
        console.log('[Pairing] TV unreachable:', error.message);
        return {
          success: false,
          error: `Cannot reach TV at ${ip}. Please check:\n1) TV is powered on\n2) TV is connected to the same network`,
          details: error.message,
        };
      }

      if (!response.ok) {
        void agent.close().catch(() => {});
        return handleErrorResponse(response, 'Pairing');
      }

      const result = await response.json();
      void agent.close().catch(() => {});

      // Every later connection in this pairing is pinned to what we saw here;
      // with nothing observed the grant still runs, but the UI warns.
      this.storePairingSession(ip, {
        auth_key: result.auth_key,
        timestamp: result.timestamp,
        device,
        certFingerprint: observed,
        agent: createTvAgent({ certFingerprint: observed ?? undefined }),
        expiresAt: Date.now() + PAIRING_SESSION_TTL_MS,
      });

      return {
        success: true,
        message: 'Check your TV screen for the PIN code',
      };
    } catch (error) {
      void agent.close().catch(() => {});
      console.log('[Pairing] Error:', error.message);
      return { success: false, error: error.message || 'Failed to initiate pairing' };
    }
  }

  // --------------------------------------------------------------------------
  // Pairing - Step 2: Grant (with PIN)
  // --------------------------------------------------------------------------

  async pairGrant(data) {
    const { ip, pin } = data ?? {};

    if (!isValidIp(ip)) {
      return { success: false, error: INVALID_IP_ERROR };
    }
    if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
      return { success: false, error: 'A 4-digit PIN is required' };
    }

    this.purgeExpiredPairingSessions();
    const session = this.pairingSessions.get(ip);
    if (!session) {
      return { success: false, error: 'No active pairing session found. Start pairing again.' };
    }

    try {
      debugLog('[PairGrant] Processing PIN...');

      const grantRequest = {
        auth: {
          auth_appId: '1',
          auth_timestamp: session.timestamp,
          auth_signature: hmacSignature(session.timestamp.toString(), pin),
          pin,
        },
        device: session.device,
      };

      const response = await this.postWithDigest(ip, '/pair/grant', grantRequest, {
        username: session.device.id,
        password: session.auth_key,
        dispatcher: session.agent,
      });

      if (!response.ok) {
        return handleErrorResponse(response, 'PairGrant');
      }

      const result = await response.json().catch(() => ({}));
      if (result?.error_id && result.error_id !== 'SUCCESS') {
        return { success: false, error: `Pairing failed: ${sanitizeForLog(String(result.error_id))} - ${sanitizeForLog(String(result.error_text || ''))}` };
      }

      this.dropPairingSession(ip);
      const success = createPairingSuccess(session, session.certFingerprint ?? undefined);
      return session.certFingerprint ? success : { ...success, certWarning: true };
    } catch (error) {
      console.log('[PairGrant] Error:', error.message);
      // A certificate that changed mid-pairing is not a TV to trust.
      // undici reports connect failures as "fetch failed" with the reason as the cause.
      const reason = `${error.message || ''} ${error.cause?.message || ''}`;
      if (/pinned fingerprint|unencrypted connection/.test(reason)) {
        this.dropPairingSession(ip);
        return {
          success: false,
          error: 'The TV presented a different certificate during pairing, so pairing was stopped. Try again; '
            + 'if this keeps happening, something on your network may be intercepting the connection.',
        };
      }
      return { success: false, error: error.message || 'Failed to complete pairing' };
    }
  }

  /**
   * POST JSON to the TV, answering a Digest challenge once if the TV issues
   * one. Returns the final response.
   */
  async postWithDigest(ip, endpoint, body, { username, password, dispatcher, timeout = CONNECTION_TIMEOUT }) {
    const url = buildUrl(ip, endpoint);
    const post = (headers) => fetchWithTimeout(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), dispatcher },
      timeout,
    );

    const initial = await post({});
    const challenge = initial.status === 401 ? initial.headers.get('www-authenticate') : null;
    if (!challenge?.toLowerCase().startsWith('digest')) {
      return initial;
    }

    debugLog(`[Digest] Retrying ${endpoint} with Digest auth...`);
    const authorization = createDigestAuth(username, password, challenge, 'POST', `/${TV_API_VERSION}${endpoint}`);
    return post({ Authorization: authorization });
  }

  // --------------------------------------------------------------------------
  // Get Sources (HDMI + Apps)
  // --------------------------------------------------------------------------

  async getSources(data) {
    const { ip, username, password, mac, certFingerprint } = data ?? {};

    if (!isValidIp(ip)) {
      return { success: false, error: INVALID_IP_ERROR };
    }

    const client = new PhilipsTVClient({
      ip,
      mac: mac || '',
      username: username || '',
      password: password || '',
      certFingerprint: certFingerprint || undefined,
    });

    try {
      debugLog(`[Sources] Getting sources from ${ip}`);

      // A TV freshly woken from standby can be slow to serve /applications, so
      // the deadline is shared across both calls rather than applied to each:
      // whatever we have — or the built-in fallback — is returned once it is
      // spent, even if the TV never answers.
      const deadline = Date.now() + WIZARD_TOTAL_DEADLINE_MS;
      const remaining = () => Math.max(0, deadline - Date.now());

      let tvSources = [];
      try {
        tvSources = await withDeadline(client.getSources(WIZARD_REQUEST_TIMEOUT_MS), remaining());
        debugLog(`[Sources] Fetched ${tvSources.length} sources from TV API`);
      } catch (sourceError) {
        console.log('[Sources] Could not fetch sources from TV, using built-in:', sourceError.message);
        tvSources = client.getBuiltInSources();
      }

      const builtInSources = tvSources.map(source => ({
        id: source.id,
        name: source.name,
        type: 'source',
        icon: source.id === WATCH_TV_URI ? 'tv' : source.id === HOME_URI ? 'home' : 'hdmi',
      }));

      let apps = [];
      try {
        apps = await withDeadline(client.getApplications(WIZARD_REQUEST_TIMEOUT_MS), remaining());
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

      // One entry per package: apps with several launcher activities are
      // reported more than once.
      const seen = new Set(builtInSources.map(s => s.id));
      const appSources = [];
      for (const app of apps) {
        const id = app.intent?.component?.packageName || app.id || app.label;
        if (!id || seen.has(id)) {
          continue;
        }
        seen.add(id);
        appSources.push({ id, name: app.label || app.name || 'Unknown App', type: 'app', icon: 'app' });
      }

      const sources = [...builtInSources, ...appSources];

      console.log(`[Sources] Found ${sources.length} sources (${builtInSources.length} built-in, ${appSources.length} apps)`);

      return { success: true, sources };
    } catch (error) {
      console.log('[Sources] Error:', error.message);
      return { success: false, error: error.message || 'Failed to get sources' };
    } finally {
      // Requests that lost the deadline race still hold pooled connections.
      void client.close().catch(() => {});
    }
  }

  // --------------------------------------------------------------------------
  // Detect Currently-Open App (for adding custom apps)
  // --------------------------------------------------------------------------

  async getCurrentApp(data) {
    const { ip, username, password, mac, certFingerprint } = data ?? {};

    if (!isValidIp(ip)) {
      return { success: false, error: INVALID_IP_ERROR };
    }

    const client = new PhilipsTVClient({
      ip,
      mac: mac || '',
      username: username || '',
      password: password || '',
      certFingerprint: certFingerprint || undefined,
    });

    try {
      debugLog(`[CurrentApp] Detecting current app on ${ip}`);

      const app = await client.getCurrentActivityIntent();

      if (!app) {
        return {
          success: false,
          error: 'No app detected. Open the app on your TV first, then try again.',
        };
      }

      // The TV's own live-TV / home / launcher activities are not a user app.
      // If detect lands on one, the wanted app isn't in the foreground, so
      // guide the user to open it first.
      if (isSystemForegroundPackage(app.packageName)) {
        const detected = sanitizeForLog(app.packageName);
        console.log(`[CurrentApp] Foreground is system activity ${detected}, not a user app`);
        return {
          success: false,
          notAnApp: true,
          detected,
          error: `The TV is currently on live TV or the home screen (${detected}). `
            + 'Open the app you want to add on the TV, then click Detect again.',
        };
      }

      console.log(`[CurrentApp] Detected ${sanitizeForLog(app.packageName)} (${sanitizeForLog(app.className || 'no class')})`);
      return { success: true, app };
    } catch (error) {
      console.log('[CurrentApp] Error:', error.message);
      return { success: false, error: error.message || 'Failed to detect current app' };
    } finally {
      void client.close().catch(() => {});
    }
  }
}

// ============================================================================
// BOOTSTRAP
// ============================================================================

(() => new UiServer())();
