/**
 * Philips TV API Client
 * Handles all communication with the Philips TV JointSpace API (v6)
 */

import { TV_API_VERSION } from './constants.js';
import {
  buildUrl,
  fetchWithTimeout,
  httpsAgent,
  createDigestAuth,
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
} from './types.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const WOL_WAKE_DELAY_MS = 2000;
const DEFAULT_TIMEOUT_MS = 15000;

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

  constructor(config: PhilipsTVClientConfig) {
    this.config = config;
  }

  // ==========================================================================
  // HTTP LAYER
  // ==========================================================================

  private async request<T>(
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
      // Initial request (may trigger 401 for digest auth)
      const initialResponse = await fetchWithTimeout(
        url,
        { method, headers, body: requestBody, agent: httpsAgent },
        timeout,
      );

      if (initialResponse.ok) {
        return this.parseJsonResponse<T>(initialResponse);
      }

      // Handle digest authentication challenge
      if (initialResponse.status === 401) {
        return this.handleDigestAuth<T>(initialResponse, method, url, uri, headers, requestBody, timeout);
      }

      return null;
    } catch {
      return null;
    }
  }

  private async handleDigestAuth<T>(
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

    const authHeader = createDigestAuth(
      this.config.username,
      this.config.password,
      wwwAuth,
      method,
      uri,
    );

    const authResponse = await fetchWithTimeout(
      url,
      {
        method,
        headers: { ...headers, Authorization: authHeader },
        body,
        agent: httpsAgent,
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
