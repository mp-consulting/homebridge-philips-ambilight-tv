import type { PhilipsTVClient } from '../api/PhilipsTVClient.js';
import type { TVDeviceConfig, AmbilightCached } from '../api/types.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Default polling interval in milliseconds */
const DEFAULT_POLLING_INTERVAL_MS = 10000;

/** Delay before first poll after accessory creation (ms) */
const INITIAL_POLL_DELAY_MS = 5000;

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
  private startupTimer?: ReturnType<typeof setTimeout>;
  private pollingTimer?: ReturnType<typeof setInterval>;

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
    const interval = this.config.pollingInterval ?? DEFAULT_POLLING_INTERVAL_MS;

    this.startupTimer = setTimeout(async () => {
      await this.pollState();
      this.callbacks.onAppsReady();
      this.pollingTimer = setInterval(() => this.pollState(), interval);
    }, INITIAL_POLL_DELAY_MS);

    this.log('debug', `Polling will start in ${INITIAL_POLL_DELAY_MS}ms, then every ${interval}ms`);
  }

  cleanup(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
    }
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }
  }

  // ==========================================================================
  // POLLING
  // ==========================================================================

  private async pollState(): Promise<void> {
    try {
      const isOn = await this.tvClient.getPowerState();
      if (isOn !== this.isPoweredOn) {
        this.isPoweredOn = isOn;
        this.callbacks.onPowerChange(isOn);
      }

      if (isOn) {
        // Ambilight state and style
        const ambilightStyle = await this.tvClient.getAmbilightStyle();
        if (ambilightStyle) {
          this.callbacks.onAmbilightUpdate(ambilightStyle, false);
        } else {
          const ambilightOn = await this.tvClient.getAmbilightPower();
          this.callbacks.onAmbilightUpdate(null, ambilightOn);
        }

        // Mute state
        const volume = await this.tvClient.getVolume();
        if (volume) {
          this.callbacks.onVolumeUpdate(volume.muted ?? false);
        }

        // Current input/activity
        const currentApp = await this.tvClient.getCurrentActivity();
        this.callbacks.onInputUpdate(currentApp);
      }
    } catch {
      // TV might be off or unreachable - this is expected
    }
  }
}
