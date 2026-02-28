/**
 * Long-poll client for Philips TV /notifychange endpoint.
 * Matches the official Philips Smart TV app behavior:
 * POSTs to /6/notifychange and blocks until the TV reports state changes.
 *
 * This client maintains its own digest auth independently from PhilipsTVClient
 * to avoid blocking the request queue.
 */

import { EventEmitter } from 'events';
import { TV_API_PORT, TV_API_HTTP_PORT, TV_API_VERSION } from '../api/constants.js';
import { fetchWithTimeout, httpsAgent } from '../api/utils.js';
import { DigestAuthSession } from '../api/DigestAuthSession.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const LONG_POLL_TIMEOUT_MS = 60_000;
const RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 5;

/** Minimum delay between consecutive long-poll requests to prevent tight loops */
const MIN_POLL_INTERVAL_MS = 2_000;

/** Resources to subscribe to.
 *  activities/tv is always included because the TV reliably pushes it on any
 *  state change, making it a useful trigger for state refreshes. */
const SUBSCRIBED_RESOURCES = {
  'activities/current': null,
  'activities/tv': null,
  'ambilight/currentconfiguration': null,
  'ambilight/power': null,
  'audio/volume': null,
  'powerstate': null,
};

// ============================================================================
// TYPES
// ============================================================================

export interface NotifyChangeClientConfig {
  ip: string;
  username: string;
  password: string;
}

// ============================================================================
// NOTIFY CHANGE CLIENT
// ============================================================================

export class NotifyChangeClient extends EventEmitter {
  private running = false;
  private abortController: AbortController | null = null;
  private consecutiveFailures = 0;
  private reconnectDelay = RECONNECT_DELAY_MS;

  /** Protocol that last worked (null = unknown, probe both) */
  private workingProtocol: 'https' | 'http' | null = null;

  /** Independent digest auth session (separate from PhilipsTVClient) */
  private readonly authSession: DigestAuthSession;

  constructor(
    private readonly config: NotifyChangeClientConfig,
    private readonly debug: (message: string) => void,
  ) {
    super();
    this.authSession = new DigestAuthSession(config.username, config.password);
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.consecutiveFailures = 0;
    this.reconnectDelay = RECONNECT_DELAY_MS;
    this.pollLoop();
  }

  stop(): void {
    this.running = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  // ==========================================================================
  // POLL LOOP
  // ==========================================================================

  private async pollLoop(): Promise<void> {
    while (this.running) {
      const start = Date.now();
      try {
        const result = await this.longPoll();
        if (result && this.running) {
          this.consecutiveFailures = 0;
          this.reconnectDelay = RECONNECT_DELAY_MS;
          this.emit('notification', result);
        }

        // Prevent tight loops when the TV responds instantly
        const elapsed = Date.now() - start;
        if (elapsed < MIN_POLL_INTERVAL_MS) {
          await this.sleep(MIN_POLL_INTERVAL_MS - elapsed);
        }
      } catch {
        if (!this.running) {
          break;
        }
        this.consecutiveFailures++;
        this.debug(`NotifyChange poll failed (${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);

        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.debug('NotifyChange: too many failures, giving up');
          this.emit('failed');
          return;
        }

        await this.sleep(this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      }
    }
  }

  // ==========================================================================
  // HTTP LONG-POLL
  // ==========================================================================

  private async longPoll(): Promise<Record<string, unknown> | null> {
    const endpoint = `/${TV_API_VERSION}/notifychange`;
    const body = JSON.stringify({ notification: SUBSCRIBED_RESOURCES });

    const allAttempts: Array<{ protocol: 'https' | 'http'; port: number; useAgent: boolean }> = [
      { protocol: 'https', port: TV_API_PORT, useAgent: true },
      { protocol: 'http', port: TV_API_HTTP_PORT, useAgent: false },
    ];

    // If we already know which protocol works, only use that one
    const attempts = this.workingProtocol
      ? allAttempts.filter(a => a.protocol === this.workingProtocol)
      : allAttempts;

    for (const { protocol, port, useAgent } of attempts) {
      const url = `${protocol}://${this.config.ip}:${port}${endpoint}`;
      // Always use full timeout — the TV blocks until a state change occurs

      try {
        const result = await this.doLongPollRequest(url, endpoint, body, useAgent, LONG_POLL_TIMEOUT_MS);
        if (result !== null) {
          if (!this.workingProtocol) {
            this.debug(`NotifyChange: ${protocol} confirmed working`);
          }
          this.workingProtocol = protocol;
          return result;
        }
      } catch {
        // Try next attempt
      }
    }

    // If known protocol failed, reset and re-probe next time
    if (this.workingProtocol) {
      this.debug('NotifyChange: known protocol failed, will re-probe');
      this.workingProtocol = null;
      this.authSession.clear();
    }

    throw new Error('All notifychange attempts failed');
  }

  private async doLongPollRequest(
    url: string,
    uri: string,
    body: string,
    useAgent: boolean,
    timeout: number,
  ): Promise<Record<string, unknown> | null> {
    this.abortController = new AbortController();

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    const authHeader = this.authSession.buildHeader('POST', uri);
    if (authHeader) {
      headers.Authorization = authHeader;
    }

    const options = {
      method: 'POST',
      headers,
      body,
      ...(useAgent ? { dispatcher: httpsAgent } : {}),
    };

    const response = await fetchWithTimeout(url, options, timeout, this.abortController?.signal);

    if (response.status === 401) {
      this.authSession.clear();
      return this.handleDigestChallenge(response, url, uri, body, useAgent);
    }

    if (response.ok) {
      return this.safeParseJson(await response.text());
    }

    return null;
  }

  // ==========================================================================
  // DIGEST AUTH
  // ==========================================================================

  private async handleDigestChallenge(
    response: Awaited<ReturnType<typeof fetchWithTimeout>>,
    url: string,
    uri: string,
    body: string,
    useAgent: boolean,
  ): Promise<Record<string, unknown> | null> {
    const wwwAuth = response.headers.get('www-authenticate');
    if (!wwwAuth || !this.authSession.cacheFromChallenge(wwwAuth)) {
      return null;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: this.authSession.buildHeader('POST', uri)!,
    };

    const authResponse = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers,
        body,
        ...(useAgent ? { dispatcher: httpsAgent } : {}),
      },
      LONG_POLL_TIMEOUT_MS,
      this.abortController?.signal,
    );

    if (authResponse.ok) {
      return this.safeParseJson(await authResponse.text());
    }

    return null;
  }

  // ==========================================================================
  // UTILITIES
  // ==========================================================================

  private safeParseJson(text: string | null | undefined): Record<string, unknown> | null {
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.debug(`NotifyChange: failed to parse JSON response: ${text.slice(0, 200)}`);
      return null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
