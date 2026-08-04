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
import type { Dispatcher } from 'undici';
import { createTvAgent, fetchWithTimeout, sanitizeForLog } from '../api/utils.js';
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
  /** SHA-256 certificate fingerprint captured at pairing time, if available. */
  certFingerprint?: string;
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

  /** Dispatcher pinned to this TV's certificate (unpinned on legacy configs) */
  private readonly agent: Dispatcher;

  constructor(
    private readonly config: NotifyChangeClientConfig,
    private readonly debug: (message: string) => void,
  ) {
    super();
    this.authSession = new DigestAuthSession(config.username, config.password);
    this.agent = createTvAgent({ certFingerprint: config.certFingerprint });
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
      } catch (error) {
        if (!this.running) {
          break;
        }
        this.consecutiveFailures++;
        // Name the reason: "answered with no changes" and "attempts failed"
        // burn the same budget but mean very different things when reading a
        // log back, and only one of them points at the network.
        const reason = error instanceof Error ? error.message : 'unknown error';
        this.debug(`NotifyChange poll failed (${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${reason}`);

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

    const allAttempts: Array<{ protocol: 'https' | 'http'; port: number }> = [
      { protocol: 'https', port: TV_API_PORT },
      // Plaintext fallback for older sets that never answer on 1926. Skipped
      // once a certificate is pinned, since downgrading to HTTP would sidestep
      // the pin entirely.
      ...(this.config.certFingerprint ? [] : [{ protocol: 'http' as const, port: TV_API_HTTP_PORT }]),
    ];

    // If we already know which protocol works, only use that one
    const attempts = this.workingProtocol
      ? allAttempts.filter(a => a.protocol === this.workingProtocol)
      : allAttempts;

    /** Set when the TV answered but reported nothing — a very different thing
     *  from the request not getting through. See the reset block below. */
    let answeredEmpty = false;

    for (const { protocol, port } of attempts) {
      const url = `${protocol}://${this.config.ip}:${port}${endpoint}`;
      // Always use full timeout — the TV blocks until a state change occurs

      try {
        const result = await this.doLongPollRequest(url, endpoint, body, LONG_POLL_TIMEOUT_MS);
        // An answer that reports nothing is not a delivery. Counting it as one
        // reset the failure budget on every lap, so a TV that keeps answering
        // empty — as one does once it drops into standby — held the channel
        // open forever and never let the caller fall back (issue #14).
        if (result !== null && Object.keys(result).length > 0) {
          if (!this.workingProtocol) {
            this.debug(`NotifyChange: ${protocol} confirmed working`);
          }
          this.workingProtocol = protocol;
          return result;
        }
        if (result !== null) {
          answeredEmpty = true;
        }
      } catch {
        // Try next attempt
      }
    }

    // If known protocol failed, reset and re-probe next time. An empty answer
    // is explicitly not that: the request reached the TV over the pinned
    // protocol and the cached digest credentials were accepted, so throwing
    // both away would buy a re-probe and a fresh 401 challenge on every empty
    // lap — precisely when the TV is dropping into standby and least able to
    // answer them. It still counts against the failure budget below; it just
    // does not count as the transport having broken.
    if (!answeredEmpty && this.workingProtocol) {
      this.debug('NotifyChange: known protocol failed, will re-probe');
      this.workingProtocol = null;
      this.authSession.clear();
    }

    throw new Error(answeredEmpty
      ? 'notifychange answered with no changes'
      : 'All notifychange attempts failed');
  }

  private async doLongPollRequest(
    url: string,
    uri: string,
    body: string,
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
      dispatcher: this.agent,
    };

    const response = await fetchWithTimeout(url, options, timeout, this.abortController?.signal);

    if (response.status === 401) {
      this.authSession.clear();
      return this.handleDigestChallenge(response, url, uri, body);
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
        dispatcher: this.agent,
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
      this.debug(`NotifyChange: failed to parse JSON response: ${sanitizeForLog(text)}`);
      return null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
