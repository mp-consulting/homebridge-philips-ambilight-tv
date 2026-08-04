import type { Characteristic, CharacteristicValue, HapStatusError, PlatformAccessory, Service } from 'homebridge';
import fs from 'fs';
import { writeFile } from 'fs/promises';
import path from 'path';

import type { PhilipsTVClient } from '../api/PhilipsTVClient.js';
import { HDMI_SOURCES, HOME_URI, WATCH_TV_URI } from '../api/PhilipsTVClient.js';
import type { CustomAppConfig, InputConfig, RemoteKey, SourceConfig } from '../api/types.js';
import { sanitizeForHomeKit } from '../api/utils.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Maximum number of input sources (static + apps). HomeKit allows up to 100
 *  services per accessory but too many causes performance issues. */
const MAX_INPUT_SOURCES = 30;

/** How long to ignore polls reporting the *previous* app after a manual switch
 *  before accepting the TV's report. Guards the wheel against bouncing back off
 *  the user's selection while the TV is still switching (a cold app start can
 *  take 10s+), without masking a switch that genuinely failed. Time-based
 *  because the long-poll can deliver several contradicting reports within a
 *  couple of seconds of the launch. */
const PENDING_CONFIRM_TIMEOUT_MS = 20_000;

/** Android launcher packages the TV reports as the current activity when it
 *  sits on the home screen — mapped to the "Home" input so the wheel and
 *  switches align after a wake from standby. Newer Philips models run the
 *  Google TV launcher (launcherx); the substring check in isLauncherPackage
 *  catches launcher variants that aren't listed here. */
const LAUNCHER_PACKAGES = new Set([
  'com.google.android.tvlauncher',
  'com.google.android.leanbacklauncher',
  'com.google.android.apps.tv.launcherx',
]);

/** True for any Android home-screen launcher the TV may report. */
function isLauncherPackage(app: string): boolean {
  return LAUNCHER_PACKAGES.has(app) || app.toLowerCase().includes('launcher');
}

/** Package the TV reports while showing the tuner or an HDMI passthrough
 *  source. Ambiguous between Watch TV and HDMI 1-4, so it confirms the current
 *  input when that is already a source, and falls back to Watch TV otherwise. */
const PLAYTV_PACKAGE = 'org.droidtv.playtv';

/** How many consecutive sightings an ambiguous system report (NA / playtv)
 *  needs before it is applied, and how recent the previous sighting must be
 *  to count as consecutive. The TV emits these transiently while switching
 *  between apps — acting on a single sighting ratcheted the state onto the
 *  wrong source (e.g. Disney+ playing but HomeKit stuck on Watch TV). A
 *  report that directly names a registered input is applied immediately. */
const AMBIGUOUS_CONFIRM_SIGHTINGS = 2;
const AMBIGUOUS_CONFIRM_WINDOW_MS = 60_000;

/** The TV's report for "no trackable app in the foreground". */
const NO_APP_REPORT = 'NA';

/** How long a selection made while the TV was off or waking is held for replay.
 *  A HomeKit scene that turns the TV on and picks a source writes both
 *  characteristics at once, but the TV needs several seconds to finish booting
 *  before it will accept a launch — so the selection is parked and re-applied
 *  once the TV is genuinely reachable. Long enough to cover a cold start from
 *  deep standby, short enough that a selection never surfaces unexpectedly
 *  much later. */
const WAKE_REPLAY_WINDOW_MS = 90_000;

/** Attempts made when replaying a parked selection. The TV answers /powerstate
 *  while its launcher is still coming up, so a single try at the power-on edge
 *  is not enough. Sized from the logs in issue #14: the earliest launch seen to
 *  succeed after a wake landed 6s past the `Power: On` edge, so the retries run
 *  well past that to leave real margin. Each attempt costs a launch, the settle
 *  below and a retry gap, which puts the last of them past WAKE_WINDOW_MS —
 *  deliberately, since a set that slow is the one still booting. The
 *  confirmation does not lapse with the window, so those attempts are checked
 *  like any other. */
const WAKE_REPLAY_ATTEMPTS = 5;
const WAKE_REPLAY_RETRY_MS = 3_000;

/** How long to let the TV settle before checking whether a replayed launch
 *  actually took. Long enough for an app that is genuinely starting to reach
 *  the foreground, so a starting app isn't mistaken for a dropped launch and
 *  relaunched under itself. */
const WAKE_CONFIRM_SETTLE_MS = 1_500;

/** How long a source picked from its own Switch takes precedence over a
 *  contradicting write to the Television service's ActiveIdentifier.
 *
 *  A Home scene captures both, and the Home app fills the TV's input in from
 *  whatever it happened to be when the scene was created — so a scene built
 *  around a source switch routinely carries an unrelated leftover input as
 *  well. Both land in the same instant with no ordering guarantee, which made
 *  the winner a coin flip (issue #17). The switch is the deliberate half of
 *  the pair: a user adds it on purpose, where the input comes along by
 *  itself. Short enough that changing the input by hand moments after using a
 *  switch still works. */
const SWITCH_PRECEDENCE_MS = 1_500;

/** TLV8 tags for DisplayOrder encoding */
const TLV_ELEMENT_START = 0x01;
const TLV_ELEMENT_END = 0x00;

/** Number of static sources (Watch TV + Home + HDMI 1-4) */
const STATIC_SOURCE_COUNT = 2 + Object.keys(HDMI_SOURCES).length;

/** System/launcher packages to exclude from auto-discovered apps */
const EXCLUDED_PACKAGES = new Set([
  'com.google.android.tvlauncher',
  'com.google.android.leanbacklauncher',
  'com.google.android.apps.tv.launcherx',
  'com.android.vending',
  'com.android.tv.settings',
  'com.google.android.katniss',
  'com.google.android.tvrecommendations',
  'org.droidtv.playtv',
  'org.droidtv.eum',
  'org.droidtv.contentexplorer',
]);

/**
 * Localized forms of HomeKit's generic "Input"/"Input Source" placeholder,
 * optionally followed by an index, that tvOS's HomeHub writes back into
 * ConfiguredName (homebridge/homebridge#3703). The Home app localizes this
 * placeholder, so an English-only match let a non-English controller silently
 * overwrite the real app label on the wheel (e.g. Spanish "Entrada 2"). We
 * ignore any write matching one of these so the friendly name survives.
 */
const GENERIC_INPUT_NAMES = [
  'input source', 'input', // English
  'entrada', // Spanish / Portuguese
  'entrée', 'entree', // French
  'eingang', // German
  'ingresso', // Italian
  'ingang', // Dutch
  'ingång', 'inngang', 'indgang', // Swedish / Norwegian / Danish
  'tulo', // Finnish
  'wejście', 'wejscie', // Polish
  'giriş', 'giris', // Turkish
  'вход', 'источник', // Russian
  '入力', '输入', '輸入', '입력', // Japanese / Chinese / Korean
];
const GENERIC_INPUT_NAME_RE = new RegExp(`^(?:${GENERIC_INPUT_NAMES.join('|')})\\s*\\d*$`, 'iu');

/** HomeKit RemoteKey to Philips TV key mapping (base, without info key) */
const HOMEKIT_TO_TV_KEY_BASE: Readonly<Record<number, RemoteKey>> = {
  0: 'Rewind',
  1: 'FastForward',
  2: 'Next',
  3: 'Previous',
  4: 'CursorUp',
  5: 'CursorDown',
  6: 'CursorLeft',
  7: 'CursorRight',
  8: 'Confirm',
  10: 'Home',
};

// ============================================================================
// TYPES
// ============================================================================

/** Input source type for HomeKit categorization */
type InputType = 'app' | 'source' | 'channel';

/** Which HomeKit control a source selection arrived from. The two are not
 *  interchangeable when they disagree — see SWITCH_PRECEDENCE_MS. */
type SelectionOrigin = 'wheel' | 'switch';

/** Runtime input source with associated HomeKit service */
interface InputSource {
  readonly id: string;
  /** Display/base name. Mutable so a package-id placeholder (used when a source
   *  is registered before the TV reports its label) can be upgraded to the real
   *  app name once the TV becomes reachable. */
  name: string;
  readonly type: InputType;
  readonly identifier: number;
  readonly service: Service;
  readonly channelListId?: string;
  /** Explicit launch activity for custom apps (apps the TV does not report). */
  readonly className?: string;
  /** Explicit launch intent action for custom apps. */
  readonly action?: string;
}

/** Persisted input source configuration (stored in accessory context) */
interface InputSourceConfig {
  readonly id: string;
  readonly name: string;
  readonly configuredName: string;
  readonly type: InputType;
  readonly identifier: number;
  readonly visibility: number;
  readonly channelListId?: string;
}

/** Raw input data before HomeKit service creation */
interface InputData {
  readonly id: string;
  readonly name: string;
  readonly type: InputType;
  readonly channelListId?: string;
  readonly className?: string;
  readonly action?: string;
}

// ============================================================================
// DEPENDENCIES
// ============================================================================

export interface InputSourceManagerDeps {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly tvClient: PhilipsTVClient;
  readonly accessory: PlatformAccessory;
  readonly storagePath: string;
  readonly deviceId: string;
  readonly userInputs?: InputConfig[];
  readonly customApps?: CustomAppConfig[];
  readonly sourceConfigs?: SourceConfig[];
  readonly infoButtonKey?: RemoteKey;
  readonly backButtonKey?: RemoteKey;
  readonly playPauseButtonKey?: RemoteKey;
  readonly communicationError: () => HapStatusError;
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** Called after new inputs are discovered so dependent services (e.g. source
   *  switches) can reconcile with the updated list. */
  readonly onInputsChanged?: () => void;
  /** Called after a wheel selection successfully switched the TV, so the source
   *  switches light up immediately instead of waiting for the next poll. */
  readonly onInputSwitched?: (sourceId: string) => void;
  /** Whether the TV is currently believed to be on. */
  readonly isPoweredOn?: () => boolean;
  /** Whether the TV was powered on recently enough that it may still be
   *  booting and rejecting launches. */
  readonly isWaking?: () => boolean;
}

// ============================================================================
// INPUT SOURCE MANAGER
// ============================================================================

export class InputSourceManager {
  private inputSources: InputSource[] = [];
  private currentInputId = 1;
  private tvService: Service | null = null;

  /** Identifier of a manual switch awaiting confirmation from the TV, and when
   *  it was requested. See PENDING_CONFIRM_TIMEOUT_MS. */
  private pendingInputId: number | null = null;
  private pendingSince = 0;

  /** Serializes wheel switches and lets a newer selection supersede queued
   *  ones, so a burst of wheel moves only launches the final choice. */
  private switchQueue: Promise<void> = Promise.resolve();
  private switchGeneration = 0;

  /** Selection made while the TV was off or still waking, held until the TV is
   *  reachable. Carries the generation it was requested under so any newer
   *  request — parked or launched, wheel or source switch — supersedes it.
   *  See WAKE_REPLAY_WINDOW_MS. */
  private wakeSelection: { input: InputSource; generation: number; parkedAt: number } | null = null;

  /** How many parked selections are being replayed right now. A count rather
   *  than a flag because a request arriving mid-replay starts a second one,
   *  and the first to finish must not report the other as done. */
  private replaysInFlight = 0;

  /** The last source picked from its own Switch, and when. Lets a leftover
   *  input carried by the same scene be ignored. See SWITCH_PRECEDENCE_MS. */
  private lastSwitchRequest: { input: InputSource; at: number } | null = null;

  /** Tracks consecutive sightings of an ambiguous system report (NA / playtv)
   *  so a lone transitional report is never applied. See AMBIGUOUS_CONFIRM_*. */
  private ambiguousReport: { app: string; sightings: number; lastSeen: number } | null = null;

  /** Apps the TV has named in a report of its own. See isOnUntrackedApp. */
  private readonly tvTrackedApps = new Set<string>();

  /** Set on the power-on edge: the input carried over from before standby is
   *  no longer evidence of what is on screen, so an ambiguous report is allowed
   *  to realign the state. Cleared by the first accepted report or selection. */
  private awaitingWakeAlignment = false;

  /** Source configs indexed by id for fast lookup */
  private sourceConfigMap: Map<string, SourceConfig>;

  /** HomeKit RemoteKey mapping (info button key is configurable) */
  private readonly remoteKeyMap: Readonly<Record<number, RemoteKey>>;

  /** File path for persisted input configs (survives restarts for external accessories) */
  private readonly inputCachePath: string;

  constructor(private readonly deps: InputSourceManagerDeps) {
    this.remoteKeyMap = {
      ...HOMEKIT_TO_TV_KEY_BASE,
      9: deps.backButtonKey ?? 'Back',
      11: deps.playPauseButtonKey ?? 'PlayPause',
      15: deps.infoButtonKey ?? 'Source',
    };
    this.sourceConfigMap = new Map(
      (deps.sourceConfigs ?? []).map(s => [s.id, s]),
    );
    const safeId = deps.deviceId.replace(/[:-]/g, '').toLowerCase();
    this.inputCachePath = path.join(deps.storagePath, `philips-tv-inputs-${safeId}.json`);
  }

  // ==========================================================================
  // ACCESSORS
  // ==========================================================================

  get currentId(): number {
    return this.currentInputId;
  }

  getSources(): readonly InputSource[] {
    return this.inputSources;
  }

  /** Record a manual switch so contradicting polls are ignored for a while. */
  private markPending(identifier: number): void {
    this.pendingInputId = identifier;
    this.pendingSince = Date.now();
    this.awaitingWakeAlignment = false;
  }

  /**
   * Tell the manager the TV has just woken. Whatever input it was left on
   * before standby says nothing about where it wakes up, so the TV's own
   * report — including an ambiguous one — is allowed to realign the state.
   */
  markAwaitingWakeAlignment(): void {
    this.awaitingWakeAlignment = true;
  }

  getVisibleSources(): readonly InputSource[] {
    const { Characteristic: Char } = this.deps;
    return this.inputSources.filter(s =>
      s.service.getCharacteristic(Char.CurrentVisibilityState).value !== Char.CurrentVisibilityState.HIDDEN,
    );
  }

  // ==========================================================================
  // CONFIGURATION
  // ==========================================================================

  /**
   * Synchronously configure input sources with static sources (HDMI) and
   * initial app sources (user-configured, cached from previous session, or empty).
   * Applies visibility and order from the sources config (Homebridge UI).
   */
  configureInputSources(tvService: Service): void {
    this.tvService = tvService;

    // Restore input configs from file (external accessories don't persist context)
    this.loadInputConfigsFromFile();

    const staticInputs = this.getStaticSources();
    const appInputs = this.getInitialAppInputs();
    // Sort app inputs so user-configured visible sources are always registered
    // first within the MAX_INPUT_SOURCES cap. Skip sorting when the user has
    // an explicit inputs[] in their config (that list has a deliberate order).
    const sortedAppInputs = (this.deps.userInputs?.length ?? 0) > 0
      ? appInputs
      : this.sortBySourcePriority(appInputs);
    const allInputs = [...staticInputs, ...sortedAppInputs].slice(0, MAX_INPUT_SOURCES);

    const cachedConfigs = this.getCachedInputConfigs();
    this.removeStaleInputSources(allInputs);

    for (const input of allInputs) {
      const identifier = this.resolveIdentifier(input.id, cachedConfigs);
      const cached = cachedConfigs.find(c => c.id === input.id);
      const inputSource = this.restoreOrCreateInputSource(input, identifier, cached, tvService);
      this.inputSources.push(inputSource);
    }

    this.saveInputConfigs();
    this.updateDisplayOrder();
    this.deps.log('info', `Configured ${this.inputSources.length} input sources`);
  }

  /**
   * Fetch applications from the TV and dynamically add new InputSource services.
   * Skipped if user has explicitly configured inputs[] in their config.
   */
  async fetchAppsFromTV(): Promise<void> {
    // If user configured explicit inputs, they manage their own list
    if (this.deps.userInputs && this.deps.userInputs.length > 0) {
      this.deps.log('debug', 'User has configured inputs — skipping auto-discovery');
      return;
    }

    try {
      const tvApps = await this.deps.tvClient.getApplications();
      if (tvApps.length === 0) {
        this.deps.log('debug', 'No apps returned from TV');
        return;
      }

      this.deps.log('debug', `Fetched ${tvApps.length} apps from TV`);

      // Build list of app inputs from TV response
      const tvAppInputs: InputData[] = tvApps
        .filter(app => {
          const pkg = app.intent?.component?.packageName;
          if (!pkg) {
            return false;
          }
          // User intent wins: never drop a package the user has explicitly
          // marked visible in the sources config, even if it's a system/launcher
          // package in EXCLUDED_PACKAGES.
          if (this.sourceConfigMap.get(pkg)?.visible === true) {
            return true;
          }
          return !EXCLUDED_PACKAGES.has(pkg);
        })
        .map(app => ({
          id: app.intent!.component!.packageName!,
          name: app.label || app.intent!.component!.packageName!,
          type: 'app' as const,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      // Upgrade placeholder names: a source registered while the TV was asleep
      // shows its package id until the TV reports the real app label. Now that we
      // have labels, replace those placeholders (and persist) so inputs and their
      // switches show a friendly name.
      const renamed = this.upgradePlaceholderNames(tvAppInputs);

      // Find new apps that aren't already in our input sources
      const existingIds = new Set(this.inputSources.map(s => s.id));
      const newApps = tvAppInputs.filter(app => !existingIds.has(app.id));

      if (newApps.length === 0) {
        this.deps.log('debug', 'No new apps to add');
        if (renamed) {
          // Names changed even though no inputs were added — persist and let the
          // source switches pick up the friendly names.
          this.saveInputConfigs();
          this.deps.onInputsChanged?.();
        }
        return;
      }

      const available = MAX_INPUT_SOURCES - this.inputSources.length;
      const appsToAdd = this.sortBySourcePriority(newApps).slice(0, available);

      if (appsToAdd.length === 0) {
        this.deps.log('debug', `Input source limit reached (${MAX_INPUT_SOURCES})`);
        if (renamed) {
          this.saveInputConfigs();
          this.deps.onInputsChanged?.();
        }
        return;
      }

      const cachedConfigs = this.getCachedInputConfigs();
      let added = 0;

      for (const app of appsToAdd) {
        if (this.inputSources.length >= MAX_INPUT_SOURCES) {
          break;
        }

        const identifier = this.resolveIdentifier(app.id, cachedConfigs);
        const cached = cachedConfigs.find(c => c.id === app.id);
        const inputSource = this.restoreOrCreateInputSource(app, identifier, cached, this.tvService!);
        this.inputSources.push(inputSource);
        added++;
      }

      this.saveInputConfigs();
      this.updateDisplayOrder();
      this.deps.log('info', `Discovered ${added} app(s) from TV (${this.inputSources.length} total inputs)`);
      if (added > 0 || renamed) {
        // New inputs arrived (e.g. the TV was asleep at boot and has now woken)
        // or placeholder names were upgraded; let dependent services rebuild —
        // notably the source switches, so their count and names stay in sync.
        this.deps.onInputsChanged?.();
      }
    } catch {
      this.deps.log('debug', 'TV not reachable for app discovery');
    }
  }

  /**
   * Replace package-id placeholder names with the real app labels the TV now
   * reports. A source registered before the TV was reachable is named after its
   * package id; once discovery returns its label we upgrade the input's name and
   * ConfiguredName in place. Never overrides a user-set custom name (from the
   * sources config) or a name the user changed in HomeKit. Returns true if any
   * input was renamed.
   */
  private upgradePlaceholderNames(discovered: InputData[]): boolean {
    const { Characteristic: Char } = this.deps;
    let changed = false;

    for (const app of discovered) {
      const input = this.inputSources.find(s => s.id === app.id);
      if (!input) {
        continue;
      }

      const placeholder = sanitizeForHomeKit(input.id);
      const realName = sanitizeForHomeKit(app.name);

      // Nothing better to offer, or the user pinned a custom name in the config.
      if (realName === placeholder || this.sourceConfigMap.get(app.id)?.customName) {
        continue;
      }

      // Only upgrade a genuine placeholder: the base name must still be the
      // package id, and the user must not have renamed it in HomeKit (which
      // would make ConfiguredName differ from the placeholder).
      const currentConfigured = input.service.getCharacteristic(Char.ConfiguredName).value;
      if (input.name !== placeholder || currentConfigured !== placeholder) {
        continue;
      }

      input.name = realName;
      input.service
        .setCharacteristic(Char.ConfiguredName, realName)
        .setCharacteristic(Char.Name, realName);
      // Re-bind the ConfiguredName get/set handlers so their cached name matches.
      this.setupInputSourceHandlers(input.service, realName);
      this.deps.log('debug', `Input name upgraded: ${placeholder} → ${realName}`);
      changed = true;
    }

    return changed;
  }

  // ==========================================================================
  // INPUT HANDLERS
  // ==========================================================================

  handleGetInput(): CharacteristicValue {
    return this.currentInputId;
  }

  async handleSetInput(value: CharacteristicValue): Promise<void> {
    const identifier = value as number;
    const inputSource = this.inputSources.find(i => i.identifier === identifier);

    if (!inputSource) {
      this.deps.log('warn', `Unknown input identifier: ${identifier}`);
      throw this.deps.communicationError();
    }

    this.deps.log('info', `Switching to: ${inputSource.name}`);
    return this.requestSwitch(inputSource, 'wheel');
  }

  /**
   * Apply a selection made through a source switch (the Switch service mirror
   * of an input). Routed through the same arbiter as the wheel so the two
   * HomeKit representations of a source cannot race: a Home scene captures
   * both the Television's ActiveIdentifier and any source switches it contains
   * and writes them at the same moment, which previously produced two
   * independent launches fighting over the TV (issue #17).
   */
  async requestSwitchById(sourceId: string): Promise<void> {
    const inputSource = this.inputSources.find(i => i.id === sourceId);
    if (!inputSource) {
      this.deps.log('warn', `Unknown source: ${sourceId}`);
      throw this.deps.communicationError();
    }
    return this.requestSwitch(inputSource, 'switch');
  }

  /**
   * The single entry point every source selection goes through, whatever
   * HomeKit control it came from. Owns the launch queue, the latest-wins
   * generation counter and the parked wake selection, so exactly one selection
   * is ever outstanding.
   */
  private async requestSwitch(inputSource: InputSource, origin: SelectionOrigin): Promise<void> {
    if (origin === 'switch') {
      this.lastSwitchRequest = { input: inputSource, at: Date.now() };
    } else if (this.isSupersededByRecentSwitch(inputSource)) {
      return;
    }

    // Coalesce bursts of selections: launches run one at a time, and a
    // selection that is superseded while waiting is skipped entirely. Without
    // this, every intermediate selection launched on the TV back-to-back —
    // the requests piled up until the newest (the one the user actually
    // wanted) was dropped by the client queue or blew HomeKit's 10s callback
    // deadline, leaving the wheel showing "No Response" until reopened.
    const generation = ++this.switchGeneration;

    // This request supersedes anything parked earlier. Leaving the old one in
    // place let a stale choice fire on the next wake and drag the TV off the
    // source the user had since picked.
    this.wakeSelection = null;

    // The TV is off. A HomeKit scene that turns the TV on and picks a source
    // writes Active and ActiveIdentifier as two independent characteristics
    // with no ordering guarantee, so this can arrive before the power-on has
    // even been sent. Launching now would fail against a TV that is not up;
    // park the choice and apply it when the TV reports in.
    if (this.deps.isPoweredOn?.() === false) {
      this.parkForWake(inputSource, generation, 'TV is off');
      return;
    }

    // The TV has accepted the power-on but may still be booting. It answers OK
    // to a launch it then quietly drops, so launching from here would report
    // success while the TV came up on its launcher instead — the request looks
    // applied in HomeKit and nothing ever retries it (issue #17). Go through
    // the replay path, which checks the source actually took and tries again
    // until it does.
    if (this.deps.isWaking?.() === true) {
      this.parkForWake(inputSource, generation, 'TV is still waking');
      return;
    }

    const task = this.switchQueue.then(async () => {
      if (generation !== this.switchGeneration) {
        this.deps.log('debug', `Skipping superseded switch to ${inputSource.name}`);
        return;
      }
      await this.performSwitch(inputSource, generation);
    });
    this.switchQueue = task.then(() => {}, () => {});
    return task;
  }

  private async performSwitch(inputSource: InputSource, generation: number): Promise<void> {
    try {
      const success = await this.switchInput(inputSource);
      if (success) {
        this.currentInputId = inputSource.identifier;
        this.markPending(inputSource.identifier);
        // Confirm the selection on the Television service. HomeKit sets
        // ActiveIdentifier optimistically, but if a subsequent poll runs before
        // the TV finishes switching it can momentarily report the old app and
        // bounce the wheel back. Re-asserting the value we just launched keeps
        // the wheel on the chosen input.
        this.tvService?.updateCharacteristic(this.deps.Characteristic.ActiveIdentifier, inputSource.identifier);
        // Align the source switches with the wheel right away — the poll that
        // would otherwise update them is suppressed while the switch is pending.
        this.deps.onInputSwitched?.(inputSource.id);
      } else {
        throw this.deps.communicationError();
      }
    } catch (error) {
      // The TV acknowledges /powerstate well before its launcher is ready, so
      // a launch fired moments after a power-on can be rejected by a TV that is
      // still booting. Park it rather than reporting failure — the same scene
      // case as above, just with the power write having landed first. A
      // selection already superseded by a newer one is simply dropped.
      if (this.deps.isWaking?.()) {
        if (generation === this.switchGeneration) {
          this.parkForWake(inputSource, generation, 'TV is still waking');
        }
        return;
      }

      if (inputSource.type === 'app') {
        // The TV rejects a launch with the wrong activity — a common cause for
        // custom apps whose launch activity isn't the guessed default.
        const attempted = inputSource.className ?? `${inputSource.id}.MainActivity`;
        this.deps.log('warn',
          `Failed to launch ${inputSource.name} (${inputSource.id}). The TV rejected the launch activity "${attempted}" — `
          + 'set the correct "Launch activity" for this custom app if it is wrong.');
      } else {
        this.deps.log('warn', `Failed to switch to ${inputSource.name}`);
      }
      throw error instanceof Error && 'hapStatus' in error ? error : this.deps.communicationError();
    }
  }

  /**
   * True when a source switch has just asked for a different source, so this
   * ActiveIdentifier write is the leftover half of a scene rather than a
   * choice the user made. Puts the wheel back on the source that won, so the
   * two HomeKit views agree instead of the scene's outcome depending on which
   * write the controller happened to send first. See SWITCH_PRECEDENCE_MS.
   */
  private isSupersededByRecentSwitch(input: InputSource): boolean {
    const recent = this.lastSwitchRequest;
    if (!recent || recent.input.id === input.id || Date.now() - recent.at > SWITCH_PRECEDENCE_MS) {
      return false;
    }

    // Hedged, because a user who picks a source switch and then changes the
    // input by hand within the window lands here too, and telling them to go
    // edit a scene they never made would be nonsense.
    this.deps.log('info',
      `Ignoring input ${input.name} — ${recent.input.name} was just selected from its switch. `
      + 'If a scene set both, remove whichever of the two you did not intend; '
      + `if you meant to pick ${input.name} yourself, choose it again.`);
    this.currentInputId = recent.input.identifier;
    this.tvService?.updateCharacteristic(this.deps.Characteristic.ActiveIdentifier, recent.input.identifier);
    return true;
  }

  // ==========================================================================
  // DEFERRED SELECTION (TV off or waking)
  // ==========================================================================

  /**
   * Hold a selection the TV cannot act on yet and show it as chosen in
   * HomeKit. Reporting an error instead would bounce the wheel back and make
   * the scene look broken, when the request is simply early.
   */
  private parkForWake(input: InputSource, generation: number, reason: string): void {
    this.wakeSelection = { input, generation, parkedAt: Date.now() };
    this.currentInputId = input.identifier;
    this.tvService?.updateCharacteristic(this.deps.Characteristic.ActiveIdentifier, input.identifier);
    // Show the parked choice on the source switches too, so the wheel and the
    // switches agree on what was asked for while the TV catches up.
    this.deps.onInputSwitched?.(input.id);
    this.deps.log('info', `${reason} — will switch to ${input.name} once it is ready`);

    // If the TV already reports on, the power-on edge that drives the replay
    // has been and gone, so nothing else would ever pick this up — retry from
    // here instead. When the TV is still off the edge is yet to come and
    // onPowerChange takes it.
    if (this.deps.isPoweredOn?.() === true) {
      void this.replayWakeSelection();
    }
  }

  /** True when a selection is parked, or is being replayed right now. The
   *  in-flight case matters because the replay clears the parked slot as it
   *  starts: without it the caller would decide nothing was outstanding and
   *  read the TV's current source back over the switch still in progress. */
  hasPendingWakeSelection(): boolean {
    return this.wakeSelection !== null || this.replaysInFlight > 0;
  }

  /**
   * Drop a parked selection. Called when the user explicitly turns the TV off:
   * the request they made before doing so is no longer wanted, and holding it
   * meant a later power-on replayed a source the user had moved on from.
   *
   * Only an explicit power-off clears it — a TV mid-boot reports standby
   * transiently, and discarding on those reports would defeat the parking.
   */
  clearWakeSelection(): void {
    if (this.wakeSelection) {
      this.deps.log('debug', `Dropping pending switch to ${this.wakeSelection.input.name} — TV turned off`);
      this.wakeSelection = null;
    }
  }

  /**
   * Apply a selection parked while the TV was off or waking. Called on the
   * power-on edge, once the TV has answered a poll and is reachable.
   */
  async replayWakeSelection(): Promise<void> {
    const parked = this.wakeSelection;
    this.wakeSelection = null;

    if (!parked) {
      return;
    }

    if (Date.now() - parked.parkedAt > WAKE_REPLAY_WINDOW_MS) {
      this.deps.log('debug', `Discarding stale pending switch to ${parked.input.name}`);
      return;
    }

    this.replaysInFlight++;
    try {
      await this.runWakeReplay(parked);
    } finally {
      this.replaysInFlight--;
    }
  }

  private async runWakeReplay(parked: { input: InputSource; generation: number }): Promise<void> {
    for (let attempt = 1; attempt <= WAKE_REPLAY_ATTEMPTS; attempt++) {
      // A newer selection while we were waiting wins — the user has moved on.
      // The generation covers both a fresh park and a live launch, either of
      // which makes this replay obsolete.
      if (this.switchGeneration !== parked.generation) {
        this.deps.log('debug', `Abandoning pending switch to ${parked.input.name} — superseded`);
        return;
      }

      try {
        const launched = await this.enqueueSwitch(parked.input, parked.generation);
        if (launched === 'superseded') {
          this.deps.log('debug', `Abandoning pending switch to ${parked.input.name} — superseded`);
          return;
        }
        // An accepted launch is not the same as a launch that took: a booting
        // TV answers OK and drops it. Confirm before believing it, and retry
        // until the TV is far enough up to act on the request.
        if (launched && await this.launchTookEffect(parked.input)) {
          // The confirmation takes a moment, and a newer selection may have
          // arrived while it ran — that one is what the user wants now.
          if (this.switchGeneration !== parked.generation) {
            this.deps.log('debug', `Abandoning pending switch to ${parked.input.name} — superseded`);
            return;
          }
          this.currentInputId = parked.input.identifier;
          this.markPending(parked.input.identifier);
          this.tvService?.updateCharacteristic(
            this.deps.Characteristic.ActiveIdentifier, parked.input.identifier,
          );
          this.deps.onInputSwitched?.(parked.input.id);
          this.deps.log('info', `Switched to ${parked.input.name} after wake`);
          return;
        }
      } catch {
        // Fall through to the retry — a TV mid-boot rejects launches.
      }

      if (attempt < WAKE_REPLAY_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, WAKE_REPLAY_RETRY_MS));
      }
    }

    this.deps.log('warn', `Could not switch to ${parked.input.name} after the TV woke up`);
  }

  /**
   * Launch on the shared switch queue, so a replay and a direct selection can
   * never have two launches outstanding on the TV at once — the queue is this
   * class's one serialization point (see requestSwitch). A replay can now
   * overlap another one, since a request arriving mid-replay starts a second,
   * which makes going through the queue rather than straight to switchInput the
   * difference between the two taking turns and both launching at once.
   *
   * The generation is re-checked inside the queued task, not just before it: a
   * newer selection can arrive while this one waits its turn, and firing the
   * old launch then would drag the TV back off the source the user has since
   * picked.
   */
  private enqueueSwitch(input: InputSource, generation: number): Promise<boolean | 'superseded'> {
    const task = this.switchQueue.then(async (): Promise<boolean | 'superseded'> => {
      if (generation !== this.switchGeneration) {
        return 'superseded';
      }
      return this.switchInput(input);
    });
    this.switchQueue = task.then(() => {}, () => {});
    return task;
  }

  /**
   * Decide whether a launch the TV accepted actually put the source on screen.
   *
   * A Philips set answers `OK` to /activities/launch while it is still coming
   * up out of standby and then does nothing with the request, so the
   * acknowledgement alone is not evidence (issue #17). Only positive evidence
   * to the contrary counts as a failure — the TV reporting its launcher, or a
   * different app. Anything inconclusive is accepted, so an app the TV never
   * names by itself is not relaunched on a loop underneath the user.
   *
   * Every replay attempt is checked, rather than only those still inside the
   * wake window. A set slow enough to need the last of the retries is exactly
   * the one that has not finished booting, and gating on the window meant the
   * check switched itself off at the point it was most needed: the retries take
   * longer than the window to run through, so the tail attempts went back to
   * trusting an acknowledgement — the very thing the window exists to distrust.
   * Only a replay reaches here, and a replay only ever runs off a wake.
   */
  private async launchTookEffect(input: InputSource): Promise<boolean> {
    // Give an app that is genuinely starting time to reach the foreground,
    // otherwise its own start-up looks like a dropped launch.
    await new Promise(resolve => setTimeout(resolve, WAKE_CONFIRM_SETTLE_MS));

    let reported: string | null;
    try {
      reported = await this.deps.tvClient.getCurrentActivity();
    } catch {
      reported = null;
    }

    // No answer at all: the TV is not up yet, so the launch cannot have taken.
    if (reported === null) {
      return false;
    }
    if (reported === input.id) {
      return true;
    }
    if (isLauncherPackage(reported)) {
      // Sitting on the home screen — right only if that is what was asked for.
      return input.id === HOME_URI;
    }
    if (reported === PLAYTV_PACKAGE) {
      // The tuner or an HDMI input — the TV reports the same package for every
      // one of them, so this says a source was reached but not which. Enough to
      // rule out the launch having been dropped, since a dropped one leaves the
      // TV on its launcher; not enough to tell HDMI1 from HDMI2, so a switch
      // between two sources is taken on trust here.
      return input.type === 'source' && input.id !== HOME_URI;
    }
    if (reported === NO_APP_REPORT) {
      // Ambiguous — the home screen on some firmwares, and every app the TV
      // does not track. Not evidence the launch was dropped.
      return true;
    }
    // The TV named a different app: ours did not take.
    this.deps.log('debug', `TV is on ${reported}, not ${input.name} — retrying the switch`);
    return false;
  }

  // ==========================================================================
  // REMOTE KEY HANDLER
  // ==========================================================================

  async handleRemoteKey(value: CharacteristicValue): Promise<void> {
    const tvKey = this.remoteKeyMap[value as number];

    if (!tvKey) {
      this.deps.log('debug', `Unknown remote key: ${value}`);
      return;
    }

    this.deps.log('debug', `Remote key: ${tvKey}`);

    try {
      const success = await this.deps.tvClient.sendKey(tvKey);
      if (!success) {
        this.deps.log('warn', 'Failed to send remote key');
      }
    } catch {
      this.deps.log('warn', 'Failed to send remote key');
    }
  }

  // ==========================================================================
  // POLLING UPDATE
  // ==========================================================================

  /**
   * Reconcile the wheel with the app the TV reports. Returns the accepted
   * input-source id (which the source switches should reflect too), or null
   * when the report was unusable or suppressed — in that case dependent
   * services must keep their current state so they don't bounce off a
   * selection the TV is still executing.
   */
  updateFromPoll(currentApp: string | null, tvService: Service): string | null {
    if (!currentApp) {
      return null;
    }
    // A registered input always wins over alias resolution, so a package the
    // user explicitly configured as an input is never remapped.
    const direct = this.inputSources.find(i => i.id === currentApp);
    const inputSource = direct
      ?? this.inputSources.find(i => i.id === this.resolveReportedApp(currentApp));
    if (!inputSource) {
      this.ambiguousReport = null;
      return null;
    }

    // The TV named a real package, so it does report this app while it runs.
    // Remember that: it is what makes a later "no app" report about it
    // meaningful rather than merely uninformative (see isOnUntrackedApp).
    if (direct && direct.type === 'app' && currentApp !== NO_APP_REPORT && currentApp !== PLAYTV_PACKAGE) {
      this.tvTrackedApps.add(direct.id);
    }

    // "No trackable app" is an absence of information, not evidence of the
    // home screen: the TV also reports it while an app it does not track sits
    // in the foreground. Treating it as Home moved the wheel off an app the
    // user was actually watching (issue #14), so it is ignored while the
    // current input is an app the TV has never named itself. Once the TV has
    // reported that app at least once, a later NA does mean the user left it.
    if (!direct && currentApp === NO_APP_REPORT && this.isOnUntrackedApp()) {
      this.ambiguousReport = null;
      this.deps.log('debug', 'Ignoring "no app" report — the TV does not track the current app');
      return null;
    }

    // NA and playtv are emitted transiently while the TV switches between
    // apps; require consecutive sightings before applying them so a lone
    // transitional report can't drag the state onto the wrong source.
    if (!direct && (currentApp === NO_APP_REPORT || currentApp === PLAYTV_PACKAGE)) {
      if (!this.recordAmbiguousSighting(currentApp)) {
        return null;
      }
    } else {
      this.ambiguousReport = null;
    }

    // A manual switch is awaiting confirmation. Ignore polls that still report
    // the previous app so the wheel doesn't bounce off the user's selection;
    // once the TV reports the pending input (or the timeout runs out — the
    // switch genuinely failed) resume normal tracking.
    if (this.pendingInputId !== null) {
      if (inputSource.identifier === this.pendingInputId) {
        this.pendingInputId = null;
      } else if (Date.now() - this.pendingSince < PENDING_CONFIRM_TIMEOUT_MS) {
        return null;
      } else {
        this.pendingInputId = null;
      }
    }

    this.awaitingWakeAlignment = false;

    if (inputSource.identifier !== this.currentInputId) {
      this.currentInputId = inputSource.identifier;
      tvService.updateCharacteristic(this.deps.Characteristic.ActiveIdentifier, this.currentInputId);
      this.deps.log('debug', `Input updated: ${inputSource.name}`);
    }
    return inputSource.id;
  }

  /**
   * Map system packages the TV reports to the input they represent. A TV on
   * its home screen reports the Android launcher (never registered as an
   * input), and the tuner/HDMI sources all report org.droidtv.playtv — without
   * this mapping a wake from standby left the wheel and switches stale because
   * the reported package matched no input.
   */
  private resolveReportedApp(app: string): string {
    if (isLauncherPackage(app)) {
      return HOME_URI;
    }
    if (app === PLAYTV_PACKAGE) {
      // playtv is ambiguous between Watch TV and HDMI 1-4: trust the current
      // input when it already is one of those, otherwise assume Watch TV.
      const current = this.inputSources.find(i => i.identifier === this.currentInputId);
      if (current && current.type === 'source' && current.id !== HOME_URI) {
        return current.id;
      }
      return WATCH_TV_URI;
    }
    if (app === NO_APP_REPORT) {
      // Firmwares that don't run a launcher package report the literal "NA"
      // on the home screen (the tuner reports playtv, tracked apps report
      // their package) — so a sustained NA means the TV is on Home. The old
      // "confirm the current source" carve-out made pressing Home from the
      // tuner invisible: NA just re-confirmed Watch TV.
      return HOME_URI;
    }
    return app;
  }

  /**
   * True when the current input is an app the TV has never reported by name.
   * Some apps never surface through /activities/current — the TV answers "no
   * trackable app" for the whole time they are on screen — so nothing about
   * such an app can be inferred from that report.
   */
  private isOnUntrackedApp(): boolean {
    if (this.awaitingWakeAlignment) {
      return false;
    }
    const current = this.inputSources.find(i => i.identifier === this.currentInputId);
    return current?.type === 'app' && !this.tvTrackedApps.has(current.id);
  }

  /**
   * Count a sighting of an ambiguous system report. Returns true once the
   * report has been seen AMBIGUOUS_CONFIRM_SIGHTINGS times in a row (within
   * the confirmation window), i.e. it reflects a settled TV state rather
   * than a transition.
   */
  private recordAmbiguousSighting(app: string): boolean {
    const now = Date.now();
    if (this.ambiguousReport
      && this.ambiguousReport.app === app
      && now - this.ambiguousReport.lastSeen <= AMBIGUOUS_CONFIRM_WINDOW_MS) {
      this.ambiguousReport.sightings++;
      this.ambiguousReport.lastSeen = now;
    } else {
      this.ambiguousReport = { app, sightings: 1, lastSeen: now };
    }
    return this.ambiguousReport.sightings >= AMBIGUOUS_CONFIRM_SIGHTINGS;
  }

  // ==========================================================================
  // PRIVATE — DISPLAY ORDER
  // ==========================================================================

  /**
   * Set the DisplayOrder TLV8 characteristic on the Television service.
   * Uses the order from the sources config (Homebridge UI) if available,
   * otherwise falls back to the array insertion order.
   */
  private updateDisplayOrder(): void {
    if (!this.tvService) {
      return;
    }

    const tlv = this.buildDisplayOrderTLV().toString('base64');
    this.tvService.setCharacteristic(this.deps.Characteristic.DisplayOrder, tlv);
    this.deps.log('debug', `Display order set for ${this.inputSources.length} inputs`);
  }

  /**
   * Encode input source identifiers as a TLV8 buffer, sorted by the
   * sources config order. Inputs without a sources config entry are
   * appended at the end.
   */
  private buildDisplayOrderTLV(): Buffer {
    // Sort identifiers by source config order
    const sorted = [...this.inputSources].sort((a, b) => {
      const orderA = this.sourceConfigMap.get(a.id)?.order;
      const orderB = this.sourceConfigMap.get(b.id)?.order;
      // Inputs with order come first, sorted by order value
      if (orderA !== undefined && orderB !== undefined) {
        return orderA - orderB;
      }
      if (orderA !== undefined) {
        return -1;
      }
      if (orderB !== undefined) {
        return 1;
      }
      // Both without order: keep original order
      return 0;
    });

    const parts: Buffer[] = [];

    for (let i = 0; i < sorted.length; i++) {
      if (i > 0) {
        parts.push(Buffer.from([TLV_ELEMENT_END, 0x00]));
      }

      const idBuf = Buffer.alloc(4);
      idBuf.writeUInt32LE(sorted[i].identifier, 0);
      parts.push(Buffer.from([TLV_ELEMENT_START, 0x04, ...idBuf]));
    }

    return Buffer.concat(parts);
  }

  // ==========================================================================
  // PRIVATE — INPUT DATA BUILDERS
  // ==========================================================================

  /**
   * Sort inputs so user-configured visible sources come first, pushing
   * explicitly-hidden and unconfigured sources toward the end. This ensures
   * visible sources are never accidentally dropped when the list is truncated
   * at MAX_INPUT_SOURCES.
   *
   * Priority order: explicitly visible (0) → no config entry (1) → explicitly hidden (2).
   * Sort is stable — relative order within each priority group is preserved.
   */
  private sortBySourcePriority(inputs: InputData[]): InputData[] {
    return [...inputs].sort((a, b) => {
      const configA = this.sourceConfigMap.get(a.id);
      const configB = this.sourceConfigMap.get(b.id);
      const priorityA = configA === undefined ? 1 : configA.visible === true ? 0 : 2;
      const priorityB = configB === undefined ? 1 : configB.visible === true ? 0 : 2;
      return priorityA - priorityB;
    });
  }

  /** Static sources that are always present: Watch TV + HDMI 1-4 */
  private getStaticSources(): InputData[] {
    const inputs: InputData[] = [];
    inputs.push({ id: WATCH_TV_URI, name: 'Watch TV', type: 'source' });
    inputs.push({ id: HOME_URI, name: 'Home', type: 'source' });
    for (const [id, name] of Object.entries(HDMI_SOURCES)) {
      inputs.push({ id, name, type: 'source' });
    }
    return inputs;
  }

  /**
   * Returns the initial set of app inputs for startup:
   * 1. If user configured inputs[] → use those (explicit list, self-managed)
   * 2. Else combine cached apps (previous TV fetch) + custom apps + every source
   *    the user marked visible in the sources config.
   *
   * Seeding from the visible sources config is what guarantees a selected source
   * always becomes an input even when the TV was asleep/slow at boot and hasn't
   * been discovered or cached yet — the app label is filled in later when the TV
   * is reachable.
   */
  private getInitialAppInputs(): InputData[] {
    const customApps = this.getCustomAppInputs();

    // User-configured inputs take priority for the explicit list
    if (this.deps.userInputs && this.deps.userInputs.length > 0) {
      const inputs = this.deps.userInputs.map(i => ({
        id: i.identifier,
        name: i.name,
        type: i.type,
      }));
      return this.mergeCustomApps(inputs, customApps);
    }

    // Base = cached apps from a previous session (apps discovered from TV)
    const cachedApps = this.getCachedInputConfigs().filter(c => c.type === 'app');
    const base = cachedApps.map(c => ({
      id: c.id,
      name: c.name,
      type: c.type as InputType,
      channelListId: c.channelListId,
    }));

    const withCustom = this.mergeCustomApps(base, customApps);
    return this.mergeConfiguredVisibleSources(withCustom);
  }

  /**
   * Append an app input for every source the user marked visible in the sources
   * config that isn't already present. Static sources (Watch TV / Home / HDMI)
   * are skipped — they're always added by getStaticSources(). This decouples the
   * user's visible selection from the TV's boot-time responsiveness.
   */
  private mergeConfiguredVisibleSources(base: InputData[]): InputData[] {
    const staticIds = new Set<string>([WATCH_TV_URI, HOME_URI, ...Object.keys(HDMI_SOURCES)]);
    const existing = new Set(base.map(b => b.id));
    const extra: InputData[] = [];

    for (const cfg of this.sourceConfigMap.values()) {
      if (cfg.visible !== true || staticIds.has(cfg.id) || existing.has(cfg.id)) {
        continue;
      }
      extra.push({
        id: cfg.id,
        // Real label is unknown until the TV is reachable; the customName (if any)
        // takes over via resolveDisplayName, otherwise fall back to the id.
        name: cfg.customName ?? cfg.id,
        type: 'app',
      });
    }

    return extra.length > 0 ? [...base, ...extra] : base;
  }

  /** Map the user's custom-app config entries to app inputs. */
  private getCustomAppInputs(): InputData[] {
    return (this.deps.customApps ?? [])
      .filter(a => a.packageName)
      .map(a => ({
        id: a.packageName,
        name: a.name || a.packageName,
        type: 'app' as const,
        className: a.className,
        action: a.action,
      }));
  }

  /**
   * Merge custom apps into a base app list. Custom apps win on id collision
   * (so their explicit launch intent overrides any cached/discovered entry)
   * and are placed first so they are never dropped by the MAX_INPUT_SOURCES cap.
   */
  private mergeCustomApps(base: InputData[], customApps: InputData[]): InputData[] {
    if (customApps.length === 0) {
      return base;
    }
    const customIds = new Set(customApps.map(a => a.id));
    return [...customApps, ...base.filter(b => !customIds.has(b.id))];
  }

  // ==========================================================================
  // PRIVATE — SOURCE CONFIG RESOLUTION
  // ==========================================================================

  /**
   * Resolve the visibility for an input source.
   * Priority: sources config (Homebridge UI) → cached config → default (SHOWN).
   */
  private resolveVisibility(inputId: string, cached: InputSourceConfig | undefined): number {
    const { Characteristic: Char } = this.deps;
    const sourceConfig = this.sourceConfigMap.get(inputId);

    // Sources config from Homebridge UI takes precedence
    if (sourceConfig?.visible !== undefined) {
      return sourceConfig.visible
        ? Char.CurrentVisibilityState.SHOWN
        : Char.CurrentVisibilityState.HIDDEN;
    }

    // Fall back to cached visibility (from previous HomeKit state)
    if (cached) {
      return cached.visibility;
    }

    return Char.CurrentVisibilityState.SHOWN;
  }

  /**
   * Resolve the display name for an input source.
   * Priority: sources config customName → cached configuredName → default name.
   */
  private resolveDisplayName(inputId: string, cached: InputSourceConfig | undefined, defaultName: string): string {
    const sourceConfig = this.sourceConfigMap.get(inputId);

    if (sourceConfig?.customName) {
      return sanitizeForHomeKit(sourceConfig.customName);
    }

    if (cached?.configuredName) {
      return cached.configuredName;
    }

    return defaultName;
  }

  // ==========================================================================
  // PRIVATE — IDENTIFIER MANAGEMENT
  // ==========================================================================

  /**
   * Resolve a stable identifier for an input.
   * Static sources always use position-based IDs (1-5).
   * Apps use persisted identifiers from cached configs, or get the next available.
   */
  private resolveIdentifier(inputId: string, cachedConfigs: InputSourceConfig[]): number {
    // Check if this input already has a cached identifier
    const cached = cachedConfigs.find(c => c.id === inputId);
    if (cached) {
      return cached.identifier;
    }

    // Assign next available identifier
    const usedIdentifiers = new Set([
      ...this.inputSources.map(s => s.identifier),
      ...cachedConfigs.map(c => c.identifier),
    ]);

    let nextId = STATIC_SOURCE_COUNT + 1;
    while (usedIdentifiers.has(nextId)) {
      nextId++;
    }

    return nextId;
  }

  // ==========================================================================
  // PRIVATE — SERVICE MANAGEMENT
  // ==========================================================================

  /** Load input configs from disk into accessory context (for external accessories) */
  private loadInputConfigsFromFile(): void {
    if (this.deps.accessory.context.inputConfigs) {
      return;
    }
    try {
      const data = fs.readFileSync(this.inputCachePath, 'utf-8');
      this.deps.accessory.context.inputConfigs = JSON.parse(data);
      this.deps.log('debug', 'Restored input configs from cache file');
    } catch {
      // No cache file yet — normal on first run
    }
  }

  private getCachedInputConfigs(): InputSourceConfig[] {
    return this.deps.accessory.context.inputConfigs || [];
  }

  private saveInputConfigs(): void {
    const { Characteristic: Char } = this.deps;
    const configs = this.inputSources.map(input => ({
      id: input.id,
      name: input.name,
      configuredName: input.service.getCharacteristic(Char.ConfiguredName).value as string,
      type: input.type,
      identifier: input.identifier,
      visibility: input.service.getCharacteristic(Char.CurrentVisibilityState).value as number,
      channelListId: input.channelListId,
    }));

    this.deps.accessory.context.inputConfigs = configs;

    // Persist to file for next restart (external accessories don't persist context)
    writeFile(this.inputCachePath, JSON.stringify(configs), 'utf-8')
      .catch(() => this.deps.log('warn', 'Failed to persist input configs to disk'));
  }

  /** Remove InputSource services that are no longer in the current input list */
  private removeStaleInputSources(currentInputs: InputData[]): void {
    const { Service: Svc } = this.deps;
    const currentIds = new Set(currentInputs.map(input => input.id));
    const cachedConfigs = this.getCachedInputConfigs();

    this.deps.accessory.services
      .filter(s => s.UUID === Svc.InputSource.UUID)
      .forEach(s => {
        const cachedConfig = cachedConfigs.find(c => `input-${c.identifier}` === s.subtype);
        if (cachedConfig && !currentIds.has(cachedConfig.id)) {
          this.deps.accessory.removeService(s);
        }
      });

    this.inputSources = [];
  }

  private restoreOrCreateInputSource(
    input: InputData,
    identifier: number,
    cached: InputSourceConfig | undefined,
    tvService: Service,
  ): InputSource {
    const { Characteristic: Char } = this.deps;
    const subtype = `input-${identifier}`;
    const defaultName = sanitizeForHomeKit(input.name);

    const inputSourceType = input.type === 'source'
      ? Char.InputSourceType.HDMI
      : Char.InputSourceType.APPLICATION;

    // Resolve visibility and name from sources config / cache / defaults
    const visibility = this.resolveVisibility(input.id, cached);
    const displayName = this.resolveDisplayName(input.id, cached, defaultName);

    let service = this.deps.accessory.getServiceById(this.deps.Service.InputSource, subtype);

    if (service) {
      service
        .setCharacteristic(Char.ConfiguredName, displayName)
        .setCharacteristic(Char.CurrentVisibilityState, visibility)
        .setCharacteristic(Char.TargetVisibilityState, visibility)
        .setCharacteristic(Char.InputSourceType, inputSourceType);
    } else {
      service = this.createInputSourceService(subtype, displayName, identifier, visibility, inputSourceType, tvService);
    }

    this.setupInputSourceHandlers(service, defaultName);

    return {
      id: input.id,
      name: defaultName,
      type: input.type,
      identifier,
      service,
      channelListId: input.channelListId,
      className: input.className,
      action: input.action,
    };
  }

  private createInputSourceService(
    subtype: string,
    displayName: string,
    identifier: number,
    visibility: number,
    inputSourceType: number,
    tvService: Service,
  ): Service {
    const { Service: Svc, Characteristic: Char } = this.deps;

    const service = this.deps.accessory.addService(Svc.InputSource, displayName, subtype);

    service
      .setCharacteristic(Char.ConfiguredName, displayName)
      .setCharacteristic(Char.InputSourceType, inputSourceType)
      .setCharacteristic(Char.IsConfigured, Char.IsConfigured.CONFIGURED)
      .setCharacteristic(Char.Name, displayName)
      .setCharacteristic(Char.CurrentVisibilityState, visibility)
      .setCharacteristic(Char.TargetVisibilityState, visibility)
      .setCharacteristic(Char.Identifier, identifier);

    tvService.addLinkedService(service);
    return service;
  }

  private setupInputSourceHandlers(service: Service, originalName: string): void {
    const { Characteristic: Char } = this.deps;
    let validName = service.getCharacteristic(Char.ConfiguredName).value as string || originalName;

    service.getCharacteristic(Char.ConfiguredName)
      .onGet(() => validName)
      .onSet((value) => {
        const newName = value as string;

        // Workaround for tvOS 18 HomeHub bug (https://github.com/homebridge/homebridge/issues/3703):
        // the controller writes its own generic, locale-dependent placeholder
        // (e.g. "Input Source 2", "Entrada 2") back into ConfiguredName. Ignore
        // it so it never clobbers the real app label.
        if (GENERIC_INPUT_NAME_RE.test(newName.trim())) {
          return;
        }

        validName = newName;
        this.deps.log('debug', `Input renamed to: ${newName}`);
        this.saveInputConfigs();
      });

    service.getCharacteristic(Char.TargetVisibilityState)
      .onSet((value) => {
        service.setCharacteristic(Char.CurrentVisibilityState, value as number);
        this.deps.log('debug', `Input visibility changed: ${value === 0 ? 'shown' : 'hidden'}`);
        this.saveInputConfigs();
      });
  }

  private async switchInput(input: InputSource): Promise<boolean> {
    switch (input.type) {
      case 'app':
        return this.deps.tvClient.launchApplication(input.id, input.className, input.action);
      case 'source':
        if (input.id === WATCH_TV_URI) {
          return this.deps.tvClient.launchWatchTV();
        }
        if (input.id === HOME_URI) {
          return this.deps.tvClient.launchHome();
        }
        return this.deps.tvClient.setSource(input.id);
      case 'channel':
        // Activate the TV tuner first to avoid black screen when switching
        // from an app or HDMI source directly to a channel
        await this.deps.tvClient.launchWatchTV();
        return this.deps.tvClient.setChannel(parseInt(input.id, 10), input.channelListId);
    }
  }
}
