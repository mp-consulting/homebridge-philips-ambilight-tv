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

/** Retry long-poll after this many ms of fallback interval polling */
const LONG_POLL_RETRY_INTERVAL_MS = 60_000;

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
  private lastAmbilight: string | null = null;
  private lastMuted: boolean | null = null;
  private lastVolume: number | null = null;
  private lastApp: string | null = null;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private pollingTimer?: ReturnType<typeof setInterval>;
  private longPollRetryTimer?: ReturnType<typeof setTimeout>;
  private notifyClient: NotifyChangeClient | null = null;
  private longPollConfirmed = false;

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

      // Start interval polling immediately as baseline
      this.startIntervalPolling();

      // Try long-poll in parallel — interval polling keeps running
      // until long-poll proves it works (first successful notification)
      this.startLongPoll();
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
    if (this.longPollRetryTimer) {
      clearTimeout(this.longPollRetryTimer);
      this.longPollRetryTimer = undefined;
    }
  }

  // ==========================================================================
  // LONG-POLL MODE
  // ==========================================================================

  private startLongPoll(): void {
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

      // activities/tv fires constantly (~every second) and is noise —
      // only trigger a state poll for resources we actually care about
      const actionableKeys = keys.filter(k => k !== 'activities/tv');
      if (actionableKeys.length === 0) {
        return;
      }

      // First actionable notification confirms long-poll works
      if (!this.longPollConfirmed) {
        this.longPollConfirmed = true;
        this.stopIntervalPolling();
        this.log('info', 'Long-poll confirmed working, stopped interval polling');
      }

      this.log('debug', `NotifyChange trigger: ${actionableKeys.join(', ')}`);
      this.pollState();
    });

    this.notifyClient.on('failed', () => {
      this.log('warn', 'Long-poll failed, ensuring interval polling is active');
      this.longPollConfirmed = false;
      this.startIntervalPolling();
      this.scheduleLongPollRetry();
    });

    this.notifyClient.start();
    this.log('debug', 'Long-poll started (interval polling remains active until confirmed)');
  }

  private stopLongPoll(): void {
    if (this.notifyClient) {
      this.notifyClient.stop();
      this.notifyClient.removeAllListeners();
      this.notifyClient = null;
    }
    this.longPollConfirmed = false;
  }

  private scheduleLongPollRetry(): void {
    if (this.longPollRetryTimer) {
      clearTimeout(this.longPollRetryTimer);
    }
    this.longPollRetryTimer = setTimeout(() => {
      this.log('info', 'Retrying long-poll mode...');
      this.startLongPoll();
    }, LONG_POLL_RETRY_INTERVAL_MS);
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
      if (isOn !== this.isPoweredOn) {
        this.isPoweredOn = isOn;
        this.log('info', `Power: ${isOn ? 'On' : 'Standby'}`);
        this.callbacks.onPowerChange(isOn);
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
