import type { PhilipsTVClient } from '../api/PhilipsTVClient.js';
import type { TVDeviceConfig, AmbilightCached } from '../api/types.js';
import { NotifyChangeClient } from './NotifyChangeClient.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Default polling interval in milliseconds */
const DEFAULT_POLLING_INTERVAL_MS = 10000;

/** Delay before first poll after accessory creation (ms) */
const INITIAL_POLL_DELAY_MS = 5000;

/** Retry long-poll after a transient failure while the TV is on */
const LONG_POLL_RETRY_MS = 60_000;

/** Minimum gap between state refreshes triggered by the noisy `activities/tv`
 *  resource. The TV pushes `activities/tv` on every state change — including
 *  app/source switches made with the physical remote, which some models never
 *  surface through `activities/current` — but it also ticks about once a second
 *  with live tuner/EPG data. Refreshing from it on a throttle keeps remote-driven
 *  changes flowing into HomeKit without polling the TV every second. */
const TV_ACTIVITY_REFRESH_THROTTLE_MS = 10_000;

// ============================================================================
// TYPES
// ============================================================================

export interface PollCallbacks {
  onPowerChange: (isOn: boolean) => void;
  onAmbilightUpdate: (style: AmbilightCached | null, powerFallback: boolean) => void;
  onVolumeUpdate: (muted: boolean) => void;
  onInputUpdate: (currentApp: string | null) => void;
  onAppsReady: () => void;
}

// ============================================================================
// STATE POLL MANAGER
// ============================================================================

export class StatePollManager {
  private isPoweredOn = false;
  private initialPowerReported = false;
  private lastAmbilight: string | null = null;
  private lastMuted: boolean | null = null;
  private lastVolume: number | null = null;
  private lastApp: string | null = null;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private pollingTimer?: ReturnType<typeof setInterval>;
  private longPollRetryTimer?: ReturnType<typeof setTimeout>;
  private notifyClient: NotifyChangeClient | null = null;
  private longPollConfirmed = false;
  /** Timestamp of the last notification-driven refresh, used to throttle activities/tv */
  private lastNotifyRefresh = 0;

  constructor(
    private readonly tvClient: PhilipsTVClient,
    private readonly config: TVDeviceConfig,
    private readonly callbacks: PollCallbacks,
    private readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void,
  ) {}

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  start(): void {
    this.startupTimer = setTimeout(async () => {
      await this.pollState();
      this.callbacks.onAppsReady();

      // Start interval polling as baseline — long-poll is started
      // automatically by pollState() when it detects the TV is on
      this.startIntervalPolling();
    }, INITIAL_POLL_DELAY_MS);

    this.log('debug', `State updates will start in ${INITIAL_POLL_DELAY_MS}ms`);
  }

  cleanup(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
    }
    this.stopIntervalPolling();
    this.stopLongPoll();
    this.cancelLongPollRetry();
  }

  // ==========================================================================
  // LONG-POLL MODE
  // ==========================================================================

  private startLongPoll(): void {
    this.stopLongPoll();
    this.cancelLongPollRetry();

    this.notifyClient = new NotifyChangeClient(
      {
        ip: this.config.ip,
        username: this.config.username,
        password: this.config.password,
      },
      (msg) => this.log('debug', msg),
    );

    this.notifyClient.on('notification', (data: Record<string, unknown>) => {
      const keys = Object.keys(data);
      if (keys.length === 0) {
        return;
      }

      // Any notification proves the long-poll channel is delivering, so the
      // interval-poll baseline can stop — including on models that only ever
      // push activities/tv, where the throttled refresh below already provides
      // the same cadence the baseline did.
      if (!this.longPollConfirmed) {
        this.longPollConfirmed = true;
        this.stopIntervalPolling();
        this.log('info', 'Long-poll confirmed working, stopped interval polling');
      }

      // A resource we track changed — refresh immediately.
      const actionableKeys = keys.filter(k => k !== 'activities/tv');
      if (actionableKeys.length > 0) {
        this.refresh(`NotifyChange trigger: ${actionableKeys.join(', ')}`);
        return;
      }

      // Only activities/tv fired. It ticks about once a second with tuner/EPG
      // data, but it is also the one resource the TV pushes on every state
      // change — including app/source switches from the physical remote that
      // some models never report through activities/current. Refresh from it on
      // a throttle so those remote-driven changes still reach HomeKit without
      // polling the TV every second.
      if (Date.now() - this.lastNotifyRefresh < TV_ACTIVITY_REFRESH_THROTTLE_MS) {
        return;
      }
      this.refresh('NotifyChange trigger: activities/tv (throttled refresh)');
    });

    this.notifyClient.on('failed', () => {
      this.stopLongPoll();
      this.startIntervalPolling();

      if (this.isPoweredOn) {
        // TV is on but long-poll failed — transient error, retry once
        this.log('warn', 'Long-poll failed while TV is on, will retry');
        this.scheduleLongPollRetry();
      } else {
        // TV is off — no point retrying, pollState() will restart
        // long-poll when the TV comes back on
        this.log('debug', 'Long-poll stopped (TV is off)');
      }
    });

    this.notifyClient.start();
    this.log('debug', 'Long-poll started (interval polling remains active until confirmed)');
  }

  /**
   * Run a state poll triggered by a notification. Stamping every such refresh
   * — not just the throttled activities/tv ones — keeps an activities/tv tick
   * arriving moments after an immediate refresh from firing a redundant poll.
   */
  private refresh(reason: string): void {
    this.lastNotifyRefresh = Date.now();
    this.log('debug', reason);
    this.pollState();
  }

  private stopLongPoll(): void {
    if (this.notifyClient) {
      this.notifyClient.stop();
      this.notifyClient.removeAllListeners();
      this.notifyClient = null;
    }
    this.longPollConfirmed = false;
    this.lastNotifyRefresh = 0;
  }

  private scheduleLongPollRetry(): void {
    this.cancelLongPollRetry();
    this.longPollRetryTimer = setTimeout(() => {
      this.log('debug', 'Retrying long-poll mode...');
      this.startLongPoll();
    }, LONG_POLL_RETRY_MS);
  }

  private cancelLongPollRetry(): void {
    if (this.longPollRetryTimer) {
      clearTimeout(this.longPollRetryTimer);
      this.longPollRetryTimer = undefined;
    }
  }

  // ==========================================================================
  // INTERVAL POLLING (baseline / fallback)
  // ==========================================================================

  private startIntervalPolling(): void {
    if (this.pollingTimer) {
      return;
    }
    const interval = this.config.pollingInterval ?? DEFAULT_POLLING_INTERVAL_MS;
    this.pollingTimer = setInterval(() => this.pollState(), interval);
    this.log('debug', `Interval polling started every ${interval}ms`);
  }

  private stopIntervalPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }
  }

  // ==========================================================================
  // FULL STATE POLL (initial sync and fallback)
  // ==========================================================================

  private async pollState(): Promise<void> {
    try {
      const isOn = await this.tvClient.getPowerState();
      const changed = isOn !== this.isPoweredOn;
      // Always report the very first observed state so consumers can establish
      // a baseline (otherwise a TV that is off at startup never reports until
      // it turns on, which then looks like the initial sync rather than a
      // genuine power-on — breaking auto-start-on-power-on).
      if (changed || !this.initialPowerReported) {
        this.isPoweredOn = isOn;
        this.initialPowerReported = true;
        if (changed) {
          this.log('info', `Power: ${isOn ? 'On' : 'Standby'}`);
        }
        this.callbacks.onPowerChange(isOn);

        if (isOn && !this.notifyClient) {
          // TV just came back — restart long-poll
          this.startLongPoll();
        } else if (!isOn) {
          // TV turned off — stop long-poll immediately
          this.stopLongPoll();
          this.cancelLongPollRetry();
        }
      }

      if (isOn) {
        const ambilightStyle = await this.tvClient.getAmbilightStyle();
        if (ambilightStyle) {
          const ambilightKey = `${ambilightStyle.styleName}/${ambilightStyle.algorithm ?? ''}`;
          if (ambilightKey !== this.lastAmbilight) {
            this.lastAmbilight = ambilightKey;
            this.log('debug', `Ambilight: ${ambilightStyle.styleName}${ambilightStyle.algorithm ? ` (${ambilightStyle.algorithm})` : ''}`);
          }
          this.callbacks.onAmbilightUpdate(ambilightStyle, false);
        } else {
          const ambilightOn = await this.tvClient.getAmbilightPower();
          const ambilightKey = ambilightOn ? 'power:on' : 'power:off';
          if (ambilightKey !== this.lastAmbilight) {
            this.lastAmbilight = ambilightKey;
            this.log('debug', `Ambilight power: ${ambilightOn ? 'On' : 'Off'}`);
          }
          this.callbacks.onAmbilightUpdate(null, ambilightOn);
        }

        const volume = await this.tvClient.getVolume();
        if (volume) {
          const muted = volume.muted ?? false;
          const current = volume.current ?? 0;
          if (muted !== this.lastMuted || current !== this.lastVolume) {
            this.lastMuted = muted;
            this.lastVolume = current;
            this.log('debug', `Volume: ${current}${muted ? ' (muted)' : ''}`);
          }
          this.callbacks.onVolumeUpdate(muted);
        }

        const currentApp = await this.tvClient.getCurrentActivity();
        if (currentApp !== this.lastApp) {
          this.lastApp = currentApp;
          this.log('debug', `Active app: ${currentApp ?? 'none'}`);
        }
        this.callbacks.onInputUpdate(currentApp);
      }
    } catch {
      // TV might be off or unreachable - this is expected
    }
  }
}
