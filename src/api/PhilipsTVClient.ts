/**
 * Philips TV API Client
 * Handles all communication with the Philips TV JointSpace API (v6)
 */

import crypto from 'crypto';
import { TV_API_VERSION } from './constants.js';
import {
  buildUrl,
  fetchWithTimeout,
  httpsAgent,
  parseWwwAuthenticate,
  md5,
  sendWakeOnLan,
} from './utils.js';
import type {
  PowerState,
  VolumeState,
  TVSource,
  TVSourceList,
  TVApplication,
  TVApplicationList,
  TVChannel,
  TVChannelList,
  RemoteKey,
  SystemInfo,
  AmbilightStyleName,
  AmbilightConfig,
  AmbilightTopology,
  AmbilightCached,
  AmbilightColor,
} from './types.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const WOL_WAKE_DELAY_MS = 1000;
const DEFAULT_TIMEOUT_MS = 2000;

/** Minimum delay between consecutive API requests to avoid overwhelming the TV */
const INTER_REQUEST_DELAY_MS = 100;

/** Ambilight menu settings node IDs (from iOS app analysis) */
const AMBILIGHT_BRIGHTNESS_NODE_ID = 2131230769;
const AMBILIGHT_SATURATION_NODE_ID = 2131230771;

/** Ambilight menu settings range */
const AMBILIGHT_SETTING_MIN = 0;
const AMBILIGHT_SETTING_MAX = 10;

/** HDMI passthrough URI prefix for Android TV */
const HDMI_PASSTHROUGH_PREFIX = 'content://android.media.tv/passthrough/com.mediatek.tvinput%2F.hdmi.HDMIInputService%2F';

/** Built-in HDMI sources for Android TV (Philips) */
export const HDMI_SOURCES: Readonly<Record<string, string>> = {
  [`${HDMI_PASSTHROUGH_PREFIX}HW5`]: 'HDMI 1',
  [`${HDMI_PASSTHROUGH_PREFIX}HW6`]: 'HDMI 2',
  [`${HDMI_PASSTHROUGH_PREFIX}HW7`]: 'HDMI 3',
  [`${HDMI_PASSTHROUGH_PREFIX}HW8`]: 'HDMI 4',
};

/** Watch TV source URI */
export const WATCH_TV_URI = 'content://android.media.tv/channel';

/** Intent action for source selection */
const SOURCE_SELECT_ACTION = 'org.droidtv.playtv.SELECTURI';

/** PlayTV component for source intents */
const PLAYTV_COMPONENT = {
  packageName: 'org.droidtv.playtv',
  className: 'org.droidtv.playtv.PlayTvActivity',
} as const;

// ============================================================================
// TYPES
// ============================================================================

export interface PhilipsTVClientConfig {
  ip: string;
  mac: string;
  username: string;
  password: string;
}

interface ApplicationIntent {
  component: { packageName: string; className: string };
  action: string;
  extras?: Record<string, unknown>;
}

// ============================================================================
// CLIENT CLASS
// ============================================================================

export class PhilipsTVClient {
  private readonly config: PhilipsTVClientConfig;
  private readonly debug: (message: string) => void;

  /** Promise chain that serializes all requests to the TV */
  private requestQueue: Promise<void> = Promise.resolve();

  /** Cached digest auth state — avoids a 401 round-trip on every request */
  private cachedAuth: {
    realm: string;
    nonce: string;
    qop: string;
    opaque?: string;
    ha1: string;
    nc: number;
  } | null = null;

  constructor(config: PhilipsTVClientConfig, debug?: (message: string) => void) {
    this.config = config;
    this.debug = debug ?? (() => {});
  }

  // ==========================================================================
  // HTTP LAYER
  // ==========================================================================

  /**
   * Queued request wrapper. Serializes all API calls so only one HTTP
   * exchange is in-flight at a time, with a small delay between requests
   * to avoid overwhelming the TV's lightweight JointSpace API server.
   */
  private request<T>(
    method: 'GET' | 'POST',
    endpoint: string,
    body?: unknown,
    timeout = DEFAULT_TIMEOUT_MS,
  ): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
      this.requestQueue = this.requestQueue.then(async () => {
        const start = Date.now();
        this.debug(`API ${method} ${endpoint}`);
        try {
          const result = await this.executeRequest<T>(method, endpoint, body, timeout);
          this.debug(`API ${method} ${endpoint} → ${result !== null ? 'OK' : 'FAIL'} (${Date.now() - start}ms)`);
          resolve(result);
        } catch {
          this.debug(`API ${method} ${endpoint} → ERROR (${Date.now() - start}ms)`);
          resolve(null);
        } finally {
          await this.sleep(INTER_REQUEST_DELAY_MS);
        }
      });
    });
  }

  /** Performs the actual HTTP request with digest auth handling. */
  private async executeRequest<T>(
    method: 'GET' | 'POST',
    endpoint: string,
    body?: unknown,
    timeout = DEFAULT_TIMEOUT_MS,
  ): Promise<T | null> {
    const url = buildUrl(this.config.ip, endpoint);
    const uri = `/${TV_API_VERSION}${endpoint}`;
    const headers: Record<string, string> = body ? { 'Content-Type': 'application/json' } : {};
    const requestBody = body ? JSON.stringify(body) : undefined;

    try {
      // If we have cached auth, send credentials proactively (single round-trip)
      if (this.cachedAuth) {
        const authHeader = this.buildCachedDigestHeader(method, uri);
        const response = await fetchWithTimeout(
          url,
          { method, headers: { ...headers, Authorization: authHeader }, body: requestBody, dispatcher: httpsAgent },
          timeout,
        );

        if (response.ok) {
          return this.parseJsonResponse<T>(response);
        }

        // Nonce expired — clear cache and fall through to fresh auth
        if (response.status === 401) {
          this.cachedAuth = null;
          return this.freshDigestAuth<T>(response, method, url, uri, headers, requestBody, timeout);
        }

        return null;
      }

      // No cached auth — initial request (may trigger 401)
      const initialResponse = await fetchWithTimeout(
        url,
        { method, headers, body: requestBody, dispatcher: httpsAgent },
        timeout,
      );

      if (initialResponse.ok) {
        return this.parseJsonResponse<T>(initialResponse);
      }

      if (initialResponse.status === 401) {
        return this.freshDigestAuth<T>(initialResponse, method, url, uri, headers, requestBody, timeout);
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Build a digest Authorization header using cached auth parameters.
   * Increments the nonce count for each use.
   */
  private buildCachedDigestHeader(method: string, uri: string): string {
    const auth = this.cachedAuth!;
    auth.nc++;
    const nc = auth.nc.toString(16).padStart(8, '0');
    const cnonce = crypto.randomBytes(16).toString('hex');

    const ha2 = md5(`${method}:${uri}`);
    const response = auth.qop
      ? md5(`${auth.ha1}:${auth.nonce}:${nc}:${cnonce}:${auth.qop}:${ha2}`)
      : md5(`${auth.ha1}:${auth.nonce}:${ha2}`);

    let header = `Digest username="${this.config.username}", realm="${auth.realm}", nonce="${auth.nonce}", uri="${uri}", response="${response}"`;

    if (auth.qop) {
      header += `, qop=${auth.qop}, nc=${nc}, cnonce="${cnonce}"`;
    }
    if (auth.opaque) {
      header += `, opaque="${auth.opaque}"`;
    }

    return header;
  }

  /**
   * Perform a fresh digest auth handshake from a 401 response,
   * caching the parameters for subsequent requests.
   */
  private async freshDigestAuth<T>(
    response: Awaited<ReturnType<typeof fetchWithTimeout>>,
    method: 'GET' | 'POST',
    url: string,
    uri: string,
    headers: Record<string, string>,
    body: string | undefined,
    timeout: number,
  ): Promise<T | null> {
    const wwwAuth = response.headers.get('www-authenticate');
    if (!wwwAuth?.toLowerCase().startsWith('digest')) {
      return null;
    }

    // Cache the auth parameters for future requests
    const params = parseWwwAuthenticate(wwwAuth);
    this.cachedAuth = {
      ...params,
      ha1: md5(`${this.config.username}:${params.realm}:${this.config.password}`),
      nc: 0,
    };

    // Use the cached header builder for the retry
    const authHeader = this.buildCachedDigestHeader(method, uri);

    const authResponse = await fetchWithTimeout(
      url,
      {
        method,
        headers: { ...headers, Authorization: authHeader },
        body,
        dispatcher: httpsAgent,
      },
      timeout,
    );

    return authResponse.ok ? this.parseJsonResponse<T>(authResponse) : null;
  }

  private async parseJsonResponse<T>(response: Awaited<ReturnType<typeof fetchWithTimeout>>): Promise<T | null> {
    const text = await response.text();
    return text ? (JSON.parse(text) as T) : null;
  }

  private get<T>(endpoint: string, timeout?: number): Promise<T | null> {
    return this.request<T>('GET', endpoint, undefined, timeout);
  }

  private post<T>(endpoint: string, body: unknown, timeout?: number): Promise<T | null> {
    return this.request<T>('POST', endpoint, body, timeout);
  }

  // ==========================================================================
  // POWER
  // ==========================================================================

  async getPowerState(): Promise<boolean> {
    const result = await this.get<PowerState>('/powerstate');
    return result?.powerstate === 'On';
  }

  async setPowerState(on: boolean): Promise<boolean> {
    if (on) {
      await this.tryWakeOnLan();
    }

    const result = await this.post('/powerstate', { powerstate: on ? 'On' : 'Standby' });
    return result !== null;
  }

  private async tryWakeOnLan(): Promise<void> {
    try {
      await sendWakeOnLan(this.config.mac);
      await this.sleep(WOL_WAKE_DELAY_MS);
    } catch {
      // WOL failed, continue with API call
    }
  }

  // ==========================================================================
  // VOLUME
  // ==========================================================================

  async getVolume(): Promise<VolumeState | null> {
    return this.get<VolumeState>('/audio/volume');
  }

  async setVolume(volume: number): Promise<boolean> {
    const result = await this.post('/audio/volume', { current: volume, muted: false });
    return result !== null;
  }

  async setMuted(muted: boolean): Promise<boolean> {
    const result = await this.post('/audio/volume', { muted });
    return result !== null;
  }

  // ==========================================================================
  // SOURCES (v6 intent-based)
  // ==========================================================================

  /**
   * Fetches available sources from the TV API.
   * Falls back to built-in sources if the API call fails.
   */
  async getSources(): Promise<TVSource[]> {
    const result = await this.get<TVSourceList>('/sources');
    if (result?.sources && result.sources.length > 0) {
      return result.sources;
    }
    // Fall back to hardcoded sources if TV doesn't return any
    return this.getBuiltInSources();
  }

  /**
   * Returns hardcoded built-in sources (Watch TV + HDMI ports).
   * Use getSources() instead for dynamic source fetching.
   */
  getBuiltInSources(): TVSource[] {
    return [
      { id: WATCH_TV_URI, name: 'Watch TV' },
      ...Object.entries(HDMI_SOURCES).map(([id, name]) => ({ id, name })),
    ];
  }

  async setSource(sourceUri: string): Promise<boolean> {
    const intent: ApplicationIntent = {
      extras: { uri: sourceUri },
      action: SOURCE_SELECT_ACTION,
      component: PLAYTV_COMPONENT,
    };

    return this.launchIntent(intent);
  }

  // ==========================================================================
  // APPLICATIONS
  // ==========================================================================

  async getApplications(): Promise<TVApplication[]> {
    const result = await this.get<TVApplicationList>('/applications');
    return result?.applications ?? [];
  }

  async launchApplication(packageName: string): Promise<boolean> {
    const intent: ApplicationIntent = {
      component: { packageName, className: 'MainActivity' },
      action: 'Intent.ACTION_MAIN',
    };

    return this.launchIntent(intent);
  }

  async getCurrentActivity(): Promise<string | null> {
    const result = await this.get<{ component?: { packageName?: string } }>('/activities/current');
    return result?.component?.packageName ?? null;
  }

  private async launchIntent(intent: ApplicationIntent): Promise<boolean> {
    const result = await this.post('/activities/launch', { intent });
    return result !== null;
  }

  // ==========================================================================
  // CHANNELS
  // ==========================================================================

  async getChannels(): Promise<TVChannel[]> {
    const result = await this.get<TVChannelList>('/channeldb/tv/channelLists/all');
    return result?.Channel ?? [];
  }

  async setChannel(ccid: number): Promise<boolean> {
    const result = await this.post('/activities/tv', {
      channel: { ccid },
      channelList: { id: 'allcab' },
    });
    return result !== null;
  }

  // ==========================================================================
  // REMOTE
  // ==========================================================================

  async sendKey(key: RemoteKey): Promise<boolean> {
    const result = await this.post('/input/key', { key });
    return result !== null;
  }

  // ==========================================================================
  // SYSTEM
  // ==========================================================================

  async getSystemInfo(): Promise<SystemInfo | null> {
    return this.get<SystemInfo>('/system');
  }

  async isReachable(): Promise<boolean> {
    const result = await this.getSystemInfo();
    return result !== null;
  }

  // ==========================================================================
  // AMBILIGHT
  // ==========================================================================

  async getAmbilightPower(): Promise<boolean> {
    const result = await this.get<{ power?: string }>('/ambilight/power');
    return result?.power === 'On';
  }

  async setAmbilightPower(on: boolean): Promise<boolean> {
    const result = await this.post('/ambilight/power', { power: on ? 'On' : 'Off' });
    return result !== null;
  }

  /**
   * Get the current Ambilight style/mode
   */
  async getAmbilightStyle(): Promise<AmbilightCached | null> {
    return this.get<AmbilightCached>('/ambilight/currentconfiguration');
  }

  /**
   * Set Ambilight to a specific style
   * @param style - The style name: OFF, FOLLOW_VIDEO, FOLLOW_AUDIO, FOLLOW_COLOR, etc.
   * @param algorithm - Optional algorithm for FOLLOW_AUDIO (e.g., 'ENERGY_ADAPTIVE_BRIGHTNESS')
   */
  async setAmbilightStyle(style: AmbilightStyleName, algorithm?: string): Promise<boolean> {
    const config: AmbilightConfig = {
      styleName: style,
      isExpert: false,
    };

    if (algorithm) {
      config.algorithm = algorithm;
      config.isExpert = true;
    }

    const result = await this.post('/ambilight/currentconfiguration', config);
    return result !== null;
  }

  /**
   * Set Ambilight to Follow Video mode
   * @param style - Video style: STANDARD, NATURAL, FOOTBALL, VIVID, GAME, COMFORT, RELAX
   */
  async setAmbilightFollowVideo(style: string = 'STANDARD'): Promise<boolean> {
    const config: AmbilightConfig = {
      styleName: 'FOLLOW_VIDEO',
      isExpert: true,
      algorithm: style,
    };
    const result = await this.post('/ambilight/currentconfiguration', config);
    return result !== null;
  }

  /**
   * Set Ambilight to Follow Audio mode
   * @param algorithm - Audio algorithm: ENERGY_ADAPTIVE_BRIGHTNESS, VU_METER, SPECTRUM_ANALYZER, etc.
   */
  async setAmbilightFollowAudio(algorithm: string = 'ENERGY_ADAPTIVE_BRIGHTNESS'): Promise<boolean> {
    const config: AmbilightConfig = {
      styleName: 'FOLLOW_AUDIO',
      isExpert: true,
      algorithm,
    };
    const result = await this.post('/ambilight/currentconfiguration', config);
    return result !== null;
  }

  /**
   * Set Ambilight to Follow Color (static color) mode
   * @param color - The color to display (hue, saturation, brightness each 0-255)
   * @param speed - Animation speed (0-255), 0 = static
   */
  async setAmbilightFollowColor(color: AmbilightColor, speed: number = 0): Promise<boolean> {
    const config: AmbilightConfig = {
      styleName: 'FOLLOW_COLOR',
      isExpert: true,
      algorithm: speed > 0 ? 'AUTOMATIC_HUE' : 'MANUAL_HUE',
      speed,
      colorSettings: {
        color,
        colorDelta: { hue: 0, saturation: 0, brightness: 0 },
        speed,
      },
    };
    const result = await this.post('/ambilight/currentconfiguration', config);
    return result !== null;
  }

  /**
   * Set Ambilight to Lounge Light mode (preset colors)
   * @param preset - Preset name: 'Hot lava', 'Deep water', 'Fresh nature', 'Warm White', 'Cool white'
   */
  async setAmbilightLounge(preset: string = 'Warm White'): Promise<boolean> {
    // Lounge light presets map to specific colors
    const presets: Record<string, AmbilightColor> = {
      'Hot lava': { hue: 0, saturation: 255, brightness: 255 },
      'Deep water': { hue: 170, saturation: 255, brightness: 255 },
      'Fresh nature': { hue: 85, saturation: 255, brightness: 255 },
      'Warm White': { hue: 30, saturation: 80, brightness: 255 },
      'Cool white': { hue: 200, saturation: 40, brightness: 255 },
    };

    const color = presets[preset] ?? presets['Warm White'];
    return this.setAmbilightFollowColor(color, 0);
  }

  /**
   * Turn Ambilight off
   */
  async setAmbilightOff(): Promise<boolean> {
    return this.setAmbilightStyle('OFF');
  }

  /**
   * Get Ambilight topology (number of LEDs on each side)
   */
  async getAmbilightTopology(): Promise<AmbilightTopology | null> {
    return this.get<AmbilightTopology>('/ambilight/topology');
  }

  /**
   * Set Ambilight brightness
   * @param brightness - Brightness level (0-10)
   */
  async setAmbilightBrightness(brightness: number): Promise<boolean> {
    const clampedBrightness = Math.max(AMBILIGHT_SETTING_MIN, Math.min(AMBILIGHT_SETTING_MAX, brightness));
    const result = await this.post('/menuitems/settings/update', {
      values: [{
        value: {
          Nodeid: AMBILIGHT_BRIGHTNESS_NODE_ID,
          data: { value: clampedBrightness },
        },
      }],
    });
    return result !== null;
  }

  /**
   * Set Ambilight saturation
   * @param saturation - Saturation level (0-10)
   */
  async setAmbilightSaturation(saturation: number): Promise<boolean> {
    const clampedSaturation = Math.max(AMBILIGHT_SETTING_MIN, Math.min(AMBILIGHT_SETTING_MAX, saturation));
    const result = await this.post('/menuitems/settings/update', {
      values: [{
        value: {
          Nodeid: AMBILIGHT_SATURATION_NODE_ID,
          data: { value: clampedSaturation },
        },
      }],
    });
    return result !== null;
  }

  // ==========================================================================
  // UTILITIES
  // ==========================================================================

  async wakeUp(): Promise<void> {
    await sendWakeOnLan(this.config.mac);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
