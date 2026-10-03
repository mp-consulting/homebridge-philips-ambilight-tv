import type { PhilipsTVClient } from '../api/PhilipsTVClient.js';
import type { TVDeviceConfig, AmbilightCached, VolumeState } from '../api/types.js';
import { sanitizeForLog } from '../api/utils.js';
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

/** How long the plugin will go without a single signal from the TV before it
 *  stops trusting the long-poll and brings the interval baseline back.
 *
 *  The channel can stop delivering without ever reporting a failure — a TV
 *  that answers /notifychange with nothing at all keeps the loop alive and the
 *  connection open — and once the baseline has been dropped there is nothing
 *  else left watching the TV.
 *
 *  Every notification counts as a signal, not just the ones that survive the
 *  activities/tv throttle. Today that makes no difference — the throttle is far
 *  below this, so a ticking channel always refreshes in time anyway — but it
 *  stops this threshold from quietly depending on that ordering holding, since
 *  the throttle bounds how often the plugin refreshes and not how often the TV
 *  pushes.
 *
 *  What nothing can bound is a TV that genuinely has nothing to report, sitting
 *  in an app with the tuner idle. Such a TV will trip this and get the baseline
 *  back, which is the safe outcome but not a free one, so it wants to be long
 *  enough that quiet sets are not put through it constantly. */
const LONG_POLL_STALE_MS = 60_000;

/** How often the staleness check above runs. */
const HEALTH_CHECK_INTERVAL_MS = 15_000;

/** Consecutive unanswered power reads before a TV believed on is reported off.
 *
 *  A TV in deep standby takes its network stack down, so silence is sometimes
 *  the only "off" signal there is — but a single dropped request is far more
 *  often a busy queue or a network blip. Reporting that as standby flipped the
 *  tile off and replayed every power-on side effect (Ambilight auto-start, wake
 *  alignment) when the next poll answered. */
const UNREACHABLE_POLLS_BEFORE_OFF = 2;

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
  private healthCheckTimer?: ReturnType<typeof setInterval>;
  private notifyClient: NotifyChangeClient | null = null;
  private longPollConfirmed = false;
  /** Timestamp of the last notification-driven refresh, used to throttle activities/tv */
  private lastNotifyRefresh = 0;
  /** Timestamp of the last proof the plugin is still seeing the TV: a state
   *  poll starting, or any notification off the long-poll channel — including
   *  the activities/tv ticks the refresh throttle swallows, which are still
   *  evidence the channel is delivering. Watched by the health check — see
   *  LONG_POLL_STALE_MS. */
  private lastTvSignal = 0;
  /** True once the health check has reported this channel stale, so a TV that
   *  simply has little to say warns the user once instead of on every lapse. */
  private staleReported = false;
  /** Consecutive power reads that got no answer — see UNREACHABLE_POLLS_BEFORE_OFF. */
  private unreachablePolls = 0;
  /** The poll currently running, so overlapping triggers share it. */
  private pollInFlight: Promise<void> | null = null;
  /** Set when a poll is requested while one is running: the running one may
   *  have read a resource before the change that prompted the request. */
  private pollRequested = false;

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
      this.startHealthCheck();
    }, INITIAL_POLL_DELAY_MS);

    this.log('debug', `State updates will start in ${INITIAL_POLL_DELAY_MS}ms`);
  }

  cleanup(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
    }
    this.stopIntervalPolling();
    this.stopHealthCheck();
    this.stopLongPoll();
    this.cancelLongPollRetry();
  }

  // ==========================================================================
  // HEALTH CHECK
  // ==========================================================================

  /**
   * Last line of defence against the plugin going quiet.
   *
   * Once a notification confirms the long-poll, the interval baseline is
   * dropped and the channel becomes the only thing watching the TV. If it then
   * stops delivering without reporting a failure, nothing notices: HomeKit
   * freezes on whatever it last saw, and the TV can be switched off from the
   * remote without the tile ever going dark (issue #14). Bringing the baseline
   * back on a stale channel bounds that to LONG_POLL_STALE_MS. Clearing
   * longPollConfirmed lets a channel that recovers drop the baseline again.
   *
   * That recovery is also why the warning only goes out once per channel. A TV
   * with genuinely little to report cycles through here — quiet, baseline back,
   * a notification eventually confirms the channel again, quiet again — and
   * that cycle is normal, not something to warn about every minute. The first
   * one is worth telling the user about; the rest are a debug detail.
   */
  private startHealthCheck(): void {
    if (this.healthCheckTimer) {
      return;
    }
    this.healthCheckTimer = setInterval(() => {
      if (!this.longPollConfirmed || Date.now() - this.lastTvSignal < LONG_POLL_STALE_MS) {
        return;
      }
      if (this.staleReported) {
        this.log('debug', 'Long-poll quiet again — resuming interval polling');
      } else {
        this.staleReported = true;
        this.log('warn', 'No state updates from the TV recently — resuming interval polling');
      }
      this.longPollConfirmed = false;
      this.startIntervalPolling();
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
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
        certFingerprint: this.config.certFingerprint,
      },
      (msg) => this.log('debug', msg),
    );

    this.notifyClient.on('notification', (data: Record<string, unknown>) => {
      const keys = Object.keys(data);
      if (keys.length === 0) {
        return;
      }

      // Anything arriving here is proof the channel is delivering, whether or
      // not it earns a refresh below. Belt and braces while the refresh throttle
      // stays well under LONG_POLL_STALE_MS — a throttled-out tick always has a
      // refresh right behind it — but it keeps the health check measuring the
      // TV rather than the throttle.
      this.lastTvSignal = Date.now();

      // Any notification proves the long-poll channel is delivering, so the
      // interval-poll baseline can stop — including on models that only ever
      // push activities/tv, where the throttled refresh below already provides
      // the same cadence the baseline did.
      if (!this.longPollConfirmed) {
        this.longPollConfirmed = true;
        this.stopIntervalPolling();
        this.log('info', 'Long-poll confirmed working, stopped interval polling');
      }

      // A resource we track changed — refresh immediately. Resource names come
      // straight off the wire, so sanitize before they reach the log.
      const actionableKeys = keys.filter(k => k !== 'activities/tv');
      if (actionableKeys.length > 0) {
        // The notification already carries the new value of each resource that
        // changed, so apply it directly rather than re-reading every resource
        // through the TV's one-at-a-time queue. Only fall back to a full poll
        // when a payload is not in a shape we recognise.
        if (this.applyNotification(data, actionableKeys)) {
          this.lastNotifyRefresh = Date.now();
          this.log('debug', `NotifyChange applied: ${sanitizeForLog(actionableKeys.join(', '))}`);
          return;
        }
        this.refresh(`NotifyChange trigger: ${sanitizeForLog(actionableKeys.join(', '))}`);
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
    void this.pollState();
  }

  /**
   * Apply the resource values a notification carries. Returns false — leaving
   * the caller to run a full poll — as soon as any actionable resource is
   * missing a payload we can read, before anything has been applied.
   */
  private applyNotification(data: Record<string, unknown>, keys: string[]): boolean {
    const updates: Array<() => void> = [];
    let powerState: boolean | null = null;

    for (const key of keys) {
      const value = data[key];
      if (!value || typeof value !== 'object') {
        return false;
      }
      const payload = value as Record<string, unknown>;

      switch (key) {
        case 'powerstate': {
          if (typeof payload.powerstate !== 'string') {
            return false;
          }
          powerState = payload.powerstate === 'On';
          break;
        }
        case 'ambilight/currentconfiguration': {
          if (typeof payload.styleName !== 'string') {
            return false;
          }
          updates.push(() => this.applyAmbilightStyle(payload as unknown as AmbilightCached));
          break;
        }
        case 'ambilight/power': {
          if (typeof payload.power !== 'string') {
            return false;
          }
          // The configuration, when it came too, is the richer of the two.
          if (!keys.includes('ambilight/currentconfiguration')) {
            const on = payload.power === 'On';
            updates.push(() => this.applyAmbilightPower(on));
          }
          break;
        }
        case 'audio/volume': {
          if (typeof payload.muted !== 'boolean' && typeof payload.current !== 'number') {
            return false;
          }
          updates.push(() => this.applyVolume(payload as unknown as VolumeState));
          break;
        }
        case 'activities/current': {
          const component = payload.component as { packageName?: unknown } | undefined;
          if (typeof component?.packageName !== 'string') {
            return false;
          }
          const pkg = component.packageName;
          updates.push(() => this.applyCurrentApp(pkg));
          break;
        }
        default:
          return false;
      }
    }

    // Power first: a TV reporting standby makes the rest moot, and one coming
    // on has to be on before its other state is applied.
    if (powerState !== null) {
      this.applyPower(powerState);
      if (!powerState) {
        return true;
      }
    }
    for (const update of updates) {
      update();
    }
    return true;
  }

  private stopLongPoll(): void {
    if (this.notifyClient) {
      this.notifyClient.stop();
      this.notifyClient.removeAllListeners();
      this.notifyClient = null;
    }
    this.longPollConfirmed = false;
    this.lastNotifyRefresh = 0;
    // A fresh channel gets a fresh warning if it too goes quiet.
    this.staleReported = false;
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

  /**
   * Read the TV's full state. Overlapping requests — the interval, a
   * notification, the health check — share the poll already running instead
   * of stacking more reads behind it in the TV's one-at-a-time queue, where
   * they would delay the user's own commands. A request that arrives mid-poll
   * earns exactly one follow-up, since the running poll may have read a
   * resource before the change that prompted it.
   */
  private pollState(): Promise<void> {
    if (this.pollInFlight) {
      this.pollRequested = true;
      return this.pollInFlight;
    }
    this.pollInFlight = (async () => {
      try {
        do {
          this.pollRequested = false;
          await this.readState();
        } while (this.pollRequested);
      } finally {
        this.pollInFlight = null;
      }
    })();
    return this.pollInFlight;
  }

  private async readState(): Promise<void> {
    // Stamped on entry rather than on completion: a poll that hangs is not
    // evidence the plugin has stopped watching, and tripping the health check
    // underneath one would start a second poller alongside it.
    this.lastTvSignal = Date.now();
    try {
      const reported = await this.tvClient.getPowerState();
      let isOn: boolean;
      if (reported === null) {
        this.unreachablePolls++;
        // Believed on and only just gone quiet: wait for a second miss before
        // calling it standby. A TV never yet seen is simply reported off.
        if (this.isPoweredOn && this.unreachablePolls < UNREACHABLE_POLLS_BEFORE_OFF) {
          this.log('debug', 'Power state unreadable — keeping the last known state for now');
          return;
        }
        isOn = false;
      } else {
        this.unreachablePolls = 0;
        isOn = reported;
      }

      this.applyPower(isOn);
      if (!isOn) {
        return;
      }

      const ambilightStyle = await this.tvClient.getAmbilightStyle();
      if (ambilightStyle) {
        this.applyAmbilightStyle(ambilightStyle);
      } else {
        this.applyAmbilightPower(await this.tvClient.getAmbilightPower());
      }

      const volume = await this.tvClient.getVolume();
      if (volume) {
        this.applyVolume(volume);
      }

      this.applyCurrentApp(await this.tvClient.getCurrentActivity());
    } catch (error) {
      // The client reports failures as null rather than throwing, so reaching
      // here means a bug in a callback — say so rather than staying silent.
      this.log('debug', `State poll failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ==========================================================================
  // STATE APPLICATION (shared by polls and notifications)
  // ==========================================================================

  private applyPower(isOn: boolean): void {
    const changed = isOn !== this.isPoweredOn;
    // Always report the very first observed state so consumers can establish
    // a baseline (otherwise a TV that is off at startup never reports until
    // it turns on, which then looks like the initial sync rather than a
    // genuine power-on — breaking auto-start-on-power-on).
    if (!changed && this.initialPowerReported) {
      return;
    }
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
      // TV turned off — stop long-poll immediately. The baseline has to
      // come back with it: if a notification had confirmed the channel,
      // interval polling was dropped and the long-poll was the only thing
      // left watching the TV. Tearing it down without this left nothing
      // polling at all, so the TV coming back on — or anything the user
      // did with the remote afterwards — never reached HomeKit again until
      // Homebridge was restarted (issue #14).
      this.stopLongPoll();
      this.cancelLongPollRetry();
      this.startIntervalPolling();
    }
  }

  private applyAmbilightStyle(style: AmbilightCached): void {
    const ambilightKey = `${style.styleName}/${style.algorithm ?? ''}`;
    if (ambilightKey !== this.lastAmbilight) {
      this.lastAmbilight = ambilightKey;
      this.log('debug', `Ambilight: ${sanitizeForLog(style.styleName)}${style.algorithm ? ` (${sanitizeForLog(style.algorithm)})` : ''}`);
    }
    this.callbacks.onAmbilightUpdate(style, false);
  }

  private applyAmbilightPower(on: boolean): void {
    const ambilightKey = on ? 'power:on' : 'power:off';
    if (ambilightKey !== this.lastAmbilight) {
      this.lastAmbilight = ambilightKey;
      this.log('debug', `Ambilight power: ${on ? 'On' : 'Off'}`);
    }
    this.callbacks.onAmbilightUpdate(null, on);
  }

  private applyVolume(volume: VolumeState): void {
    const muted = volume.muted ?? false;
    const current = volume.current ?? 0;
    if (muted !== this.lastMuted || current !== this.lastVolume) {
      this.lastMuted = muted;
      this.lastVolume = current;
      this.log('debug', `Volume: ${current}${muted ? ' (muted)' : ''}`);
    }
    this.callbacks.onVolumeUpdate(muted);
  }

  private applyCurrentApp(currentApp: string | null): void {
    if (currentApp !== this.lastApp) {
      this.lastApp = currentApp;
      this.log('debug', `Active app: ${currentApp === null ? 'none' : sanitizeForLog(currentApp)}`);
    }
    this.callbacks.onInputUpdate(currentApp);
  }
}
