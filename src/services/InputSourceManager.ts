import type { Characteristic, CharacteristicValue, HapStatusError, PlatformAccessory, Service } from 'homebridge';

import type { PhilipsTVClient } from '../api/PhilipsTVClient.js';
import { HOME_URI, WATCH_TV_URI } from '../api/PhilipsTVClient.js';
import type { CustomAppConfig, InputConfig, RemoteKey, SourceConfig } from '../api/types.js';
import { sanitizeForHomeKit, sanitizeForLog } from '../api/utils.js';
import {
  AMBIGUOUS_CONFIRM_SIGHTINGS,
  AMBIGUOUS_CONFIRM_WINDOW_MS,
  HOMEKIT_TO_TV_KEY_BASE,
  MAX_INPUT_SOURCES,
  NO_APP_REPORT,
  PENDING_CONFIRM_TIMEOUT_MS,
  PLAYTV_PACKAGE,
  SCENE_COALESCE_MS,
  SWITCH_PRECEDENCE_MS,
  WAKE_CONFIRM_SETTLE_MS,
  WAKE_REPLAY_ATTEMPTS,
  WAKE_REPLAY_RETRY_MS,
  WAKE_REPLAY_WINDOW_MS,
  isLauncherPackage,
} from './inputs/constants.js';
import { InputCatalog, reportedPackages } from './inputs/InputCatalog.js';
import { InputConfigStore } from './inputs/InputConfigStore.js';
import { InputServiceFactory, buildDisplayOrderTLV } from './inputs/InputServiceFactory.js';
import type { InputData, InputSource, SelectionOrigin } from './inputs/types.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Consecutive successful app listings an app must be missing from before its
 *  input is removed. A TV that has only just woken can answer with a partial
 *  list, and dropping an input re-numbers it if it comes back — breaking the
 *  scenes and automations that point at it. */
const PRUNE_AFTER_MISSED_LISTINGS = 2;

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
  /** Whether sources are also exposed as individual Switch services. Only then
   *  can a scene carry both a switch and a contradicting input, so only then is
   *  an ActiveIdentifier write held back to see if a switch follows it. See
   *  SCENE_COALESCE_MS. */
  readonly hasSourceSwitches?: () => boolean;
}

// ============================================================================
// INPUT SOURCE MANAGER
// ============================================================================

/**
 * Owns the TV's inputs as HomeKit sees them and arbitrates every request to
 * switch between them.
 *
 * Which inputs exist is decided by {@link InputCatalog}; their identifiers and
 * names are persisted by {@link InputConfigStore}; their HomeKit services are
 * built by {@link InputServiceFactory}. What stays here is the stateful part:
 * the launch queue, the selection parked while the TV wakes, and reconciling
 * the wheel with what the TV reports.
 */
export class InputSourceManager {
  private inputSources: InputSource[] = [];
  private inputsById = new Map<string, InputSource>();
  private inputsByIdentifier = new Map<number, InputSource>();
  /** Points at a real input once configureInputSources has run. */
  private currentInputId = 0;
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

  /** How many consecutive app listings each app input has been missing from. */
  private readonly missedListings = new Map<string, number>();

  /** Source configs indexed by id for fast lookup */
  private readonly sourceConfigMap: ReadonlyMap<string, SourceConfig>;

  /** Display position of each entry in an explicit inputs[] list. */
  private readonly userInputOrder: ReadonlyMap<string, number>;

  /** HomeKit RemoteKey mapping (info button key is configurable) */
  private readonly remoteKeyMap: Readonly<Record<number, RemoteKey>>;

  private readonly catalog: InputCatalog;
  private readonly store: InputConfigStore;
  private readonly factory: InputServiceFactory;

  constructor(private readonly deps: InputSourceManagerDeps) {
    this.remoteKeyMap = {
      ...HOMEKIT_TO_TV_KEY_BASE,
      9: deps.backButtonKey ?? 'Back',
      11: deps.playPauseButtonKey ?? 'PlayPause',
      15: deps.infoButtonKey ?? 'Source',
    };
    this.sourceConfigMap = new Map((deps.sourceConfigs ?? []).map(s => [s.id, s]));
    this.userInputOrder = new Map(
      (deps.userInputs ?? []).map((input, index) => [input.identifier, input.displayOrder ?? index]),
    );
    this.catalog = new InputCatalog({
      userInputs: deps.userInputs,
      customApps: deps.customApps,
      sourceConfigs: this.sourceConfigMap,
    });
    this.store = new InputConfigStore({
      accessory: deps.accessory,
      storagePath: deps.storagePath,
      deviceId: deps.deviceId,
      log: deps.log,
    });
    this.factory = new InputServiceFactory({
      Service: deps.Service,
      Characteristic: deps.Characteristic,
      accessory: deps.accessory,
      sourceConfigs: this.sourceConfigMap,
      log: deps.log,
      onConfigChanged: () => this.saveInputConfigs(),
    });
  }

  // ==========================================================================
  // ACCESSORS
  // ==========================================================================

  /** @internal The identifier of the current input — exposed for tests. */
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

  /** Write any pending input-config save now (Homebridge shutdown). */
  flushPendingSaves(): Promise<void> {
    return this.store.flush();
  }

  private currentInput(): InputSource | undefined {
    return this.inputsByIdentifier.get(this.currentInputId);
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
    this.store.load();
    const cachedConfigs = [...this.store.all];

    const allInputs = this.catalog.startupInputs(cachedConfigs);
    this.factory.removeStale(new Set(allInputs.map(input => input.id)), cachedConfigs);

    this.setInputs([]);
    for (const input of allInputs) {
      this.addInput(input, tvService);
    }

    // Start on a real input. Identifiers are allocated per install (a fresh
    // one numbers its static sources from STATIC_SOURCE_COUNT + 1), so no
    // fixed number is guaranteed to exist; Watch TV always does.
    this.currentInputId = (this.inputsById.get(WATCH_TV_URI) ?? this.inputSources[0])?.identifier ?? 0;
    tvService.updateCharacteristic(this.deps.Characteristic.ActiveIdentifier, this.currentInputId);

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
    if (this.catalog.hasUserInputs) {
      this.deps.log('debug', 'User has configured inputs — skipping auto-discovery');
      return;
    }
    const tvService = this.tvService;
    if (!tvService) {
      return;
    }

    try {
      const tvApps = await this.deps.tvClient.getApplications();
      if (tvApps.length === 0) {
        this.deps.log('debug', 'No apps returned from TV');
        return;
      }

      this.deps.log('debug', `Fetched ${tvApps.length} apps from TV`);

      // One input per package, sorted by name
      const tvAppInputs = this.catalog.appsFromTV(tvApps);

      // Upgrade placeholder names: a source registered while the TV was asleep
      // shows its package id until the TV reports the real app label. Now that we
      // have labels, replace those placeholders (and persist) so inputs and their
      // switches show a friendly name.
      const renamed = this.upgradePlaceholderNames(tvAppInputs);
      const pruned = this.pruneUninstalledApps(reportedPackages(tvApps));

      const newApps = tvAppInputs.filter(app => !this.inputsById.has(app.id));
      const available = Math.max(0, MAX_INPUT_SOURCES - this.inputSources.length);
      const appsToAdd = this.catalog.sortBySourcePriority(newApps).slice(0, available);

      if (newApps.length > appsToAdd.length) {
        this.deps.log('debug', `Input source limit reached (${MAX_INPUT_SOURCES})`);
      }

      for (const app of appsToAdd) {
        this.addInput(app, tvService);
      }

      if (appsToAdd.length > 0) {
        this.deps.log('info', `Discovered ${appsToAdd.length} app(s) from TV (${this.inputSources.length} total inputs)`);
      } else {
        this.deps.log('debug', 'No new apps to add');
      }

      if (appsToAdd.length > 0 || pruned > 0) {
        this.updateDisplayOrder();
      }
      if (appsToAdd.length > 0 || pruned > 0 || renamed) {
        // New inputs arrived (e.g. the TV was asleep at boot and has now woken),
        // stale ones went, or placeholder names were upgraded; let dependent
        // services rebuild — notably the source switches, so their count and
        // names stay in sync.
        this.commitInputsChanged();
      }
    } catch (error) {
      // The client reports an unreachable TV as an empty list, so anything
      // thrown here is a bug rather than the network.
      this.deps.log('warn', `App discovery failed: ${sanitizeForLog(error instanceof Error ? error.message : String(error))}`);
    }
  }

  /**
   * Remove app inputs the TV has stopped reporting (uninstalled apps), which
   * otherwise accumulate across restarts until they crowd new apps out of the
   * MAX_INPUT_SOURCES slots. Never removes an app the user asked for (a custom
   * app or one marked visible in the sources config), the current input, or
   * one a parked selection is waiting on. Returns how many were removed.
   */
  private pruneUninstalledApps(reported: ReadonlySet<string>): number {
    const stale: InputSource[] = [];
    for (const input of this.inputSources) {
      if (input.type !== 'app' || reported.has(input.id)) {
        this.missedListings.delete(input.id);
        continue;
      }
      if (
        this.catalog.isUserRequested(input.id)
        || input.identifier === this.currentInputId
        || this.wakeSelection?.input.id === input.id
      ) {
        continue;
      }
      const misses = (this.missedListings.get(input.id) ?? 0) + 1;
      this.missedListings.set(input.id, misses);
      if (misses >= PRUNE_AFTER_MISSED_LISTINGS) {
        stale.push(input);
      }
    }

    if (stale.length === 0) {
      return 0;
    }
    const staleIds = new Set(stale.map(s => s.id));
    for (const input of stale) {
      this.factory.remove(input);
      this.missedListings.delete(input.id);
    }
    this.setInputs(this.inputSources.filter(s => !staleIds.has(s.id)));
    this.deps.log('info', `Removed ${stale.length} app(s) no longer installed on the TV: ${stale.map(s => s.name).join(', ')}`);
    return stale.length;
  }

  /**
   * Replace package-id placeholder names with the real app labels the TV now
   * reports. A source registered before the TV was reachable is named after its
   * package id; once discovery returns its label we upgrade the input's name and
   * ConfiguredName in place. Never overrides a user-set custom name (from the
   * sources config) or a name the user changed in HomeKit. Returns true if any
   * input was renamed.
   */
  private upgradePlaceholderNames(discovered: readonly InputData[]): boolean {
    const { Characteristic: Char } = this.deps;
    let changed = false;

    for (const app of discovered) {
      const input = this.inputsById.get(app.id);
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
      this.factory.bindHandlers(input.service, realName);
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
    const inputSource = this.inputsByIdentifier.get(identifier);

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
    const inputSource = this.inputsById.get(sourceId);
    if (!inputSource) {
      this.deps.log('warn', `Unknown source: ${sanitizeForLog(sourceId)}`);
      throw this.deps.communicationError();
    }
    return this.requestSwitch(inputSource, 'switch');
  }

  /**
   * The single entry point every source selection goes through, whatever
   * HomeKit control it came from. Owns the launch queue, the latest-wins
   * generation counter and the parked wake selection, so exactly one selection
   * is ever outstanding.
   *
   * A selection from a switch is acted on at once; one from the wheel waits
   * long enough to see whether a switch is arriving behind it, since a scene
   * can carry both and the two would otherwise settle differently depending on
   * the order the Home app sent them. See SCENE_COALESCE_MS.
   */
  private async requestSwitch(inputSource: InputSource, origin: SelectionOrigin): Promise<void> {
    if (origin === 'switch') {
      this.lastSwitchRequest = { input: inputSource, at: Date.now() };
    } else {
      // Give the other half of a scene time to arrive before acting on this
      // one — until it has, there is nothing to compare against and both
      // orders of the same scene would not settle the same way.
      if (this.deps.hasSourceSwitches?.()) {
        await new Promise(resolve => setTimeout(resolve, SCENE_COALESCE_MS));
      }
      if (this.isSupersededByRecentSwitch(inputSource)) {
        return;
      }
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
    // Which launch activity the TV rejected is only settled inside the client,
    // which falls back through the configured one, the intent the TV reported
    // for the app, and a guess — so it has to report back what it sent.
    let attemptedActivity: string | undefined;
    try {
      const success = await this.switchInput(inputSource, activity => {
        attemptedActivity = activity;
      });
      if (!success) {
        throw this.deps.communicationError();
      }
      // A newer selection arrived while this launch was in flight. It is now
      // what the user wants, and committing this one would put the wheel and
      // switches back on a source they have already moved off — and drop the
      // newer parked choice's pending guard.
      if (generation !== this.switchGeneration) {
        this.deps.log('debug', `Launched ${inputSource.name}, but a newer selection superseded it`);
        return;
      }
      this.commitSelection(inputSource);
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
        const attempted = attemptedActivity ?? inputSource.className ?? `${inputSource.id}.MainActivity`;
        this.deps.log('warn',
          `Failed to launch ${inputSource.name} (${sanitizeForLog(inputSource.id)}). The TV rejected the launch activity "${sanitizeForLog(attempted)}" — `
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
          this.commitSelection(parked.input);
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
    this.deps.log('debug', `TV is on ${sanitizeForLog(reported)}, not ${input.name} — retrying the switch`);
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
    const direct = this.inputsById.get(currentApp);
    const inputSource = direct ?? this.inputsById.get(this.resolveReportedApp(currentApp));
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
      const current = this.currentInput();
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
    const current = this.currentInput();
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
  // PRIVATE — INPUT REGISTRY
  // ==========================================================================

  /** Create (or restore) the service for `input` and register it. */
  private addInput(input: InputData, tvService: Service): void {
    const identifier = this.store.resolveIdentifier(input.id, this.inputsByIdentifier.keys());
    const inputSource = this.factory.restoreOrCreate(input, identifier, this.store.get(input.id), tvService);
    this.setInputs([...this.inputSources, inputSource]);
  }

  /** Replace the input list and rebuild the lookups every poll relies on. */
  private setInputs(inputs: InputSource[]): void {
    this.inputSources = inputs;
    this.inputsById = new Map(inputs.map(i => [i.id, i]));
    this.inputsByIdentifier = new Map(inputs.map(i => [i.identifier, i]));
  }

  /**
   * Make `input` the current selection everywhere: the wheel, the pending
   * guard against contradicting polls, and the source switches.
   */
  private commitSelection(input: InputSource): void {
    this.currentInputId = input.identifier;
    this.markPending(input.identifier);
    // Confirm the selection on the Television service. HomeKit sets
    // ActiveIdentifier optimistically, but if a subsequent poll runs before
    // the TV finishes switching it can momentarily report the old app and
    // bounce the wheel back. Re-asserting the value we just launched keeps
    // the wheel on the chosen input.
    this.tvService?.updateCharacteristic(this.deps.Characteristic.ActiveIdentifier, input.identifier);
    // Align the source switches with the wheel right away — the poll that
    // would otherwise update them is suppressed while the switch is pending.
    this.deps.onInputSwitched?.(input.id);
  }

  /** Persist the inputs and let dependent services catch up. */
  private commitInputsChanged(): void {
    this.saveInputConfigs();
    this.deps.onInputsChanged?.();
  }

  private saveInputConfigs(): void {
    this.store.save(this.inputSources.map(input => this.factory.toConfig(input)));
  }

  // ==========================================================================
  // PRIVATE — DISPLAY ORDER
  // ==========================================================================

  /**
   * Set the DisplayOrder TLV8 characteristic on the Television service: the
   * sources config (Homebridge UI) order first, then an explicit inputs[]
   * list's displayOrder, then registration order.
   */
  private updateDisplayOrder(): void {
    if (!this.tvService) {
      return;
    }

    const tlv = buildDisplayOrderTLV(
      this.inputSources,
      id => this.sourceConfigMap.get(id)?.order ?? this.userInputOrder.get(id),
    ).toString('base64');
    this.tvService.setCharacteristic(this.deps.Characteristic.DisplayOrder, tlv);
    this.deps.log('debug', `Display order set for ${this.inputSources.length} inputs`);
  }

  // ==========================================================================
  // PRIVATE — LAUNCHING
  // ==========================================================================

  private async switchInput(input: InputSource, onAttempt?: (activity: string) => void): Promise<boolean> {
    switch (input.type) {
      case 'app':
        return this.deps.tvClient.launchApplication(input.id, input.className, input.action, onAttempt);
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
      // from an app or HDMI source directly to a channel. The channel is
      // still requested if that fails — the TV may already be on the tuner.
        if (!(await this.deps.tvClient.launchWatchTV())) {
          this.deps.log('debug', `Could not bring up the tuner before switching to ${input.name}; trying the channel anyway`);
        }
        return this.deps.tvClient.setChannel(parseInt(input.id, 10));
    }
  }
}
