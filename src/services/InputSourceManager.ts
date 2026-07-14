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
 *  switches align after a wake from standby. */
const LAUNCHER_PACKAGES = new Set([
  'com.google.android.tvlauncher',
  'com.google.android.leanbacklauncher',
]);

/** Package the TV reports while showing the tuner or an HDMI passthrough
 *  source. Ambiguous between Watch TV and HDMI 1-4, so it confirms the current
 *  input when that is already a source, and falls back to Watch TV otherwise. */
const PLAYTV_PACKAGE = 'org.droidtv.playtv';

/** TLV8 tags for DisplayOrder encoding */
const TLV_ELEMENT_START = 0x01;
const TLV_ELEMENT_END = 0x00;

/** Number of static sources (Watch TV + Home + HDMI 1-4) */
const STATIC_SOURCE_COUNT = 2 + Object.keys(HDMI_SOURCES).length;

/** System/launcher packages to exclude from auto-discovered apps */
const EXCLUDED_PACKAGES = new Set([
  'com.google.android.tvlauncher',
  'com.google.android.leanbacklauncher',
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

  /** Update ActiveIdentifier on the Television service from a source ID (e.g. from a source switch). */
  setActiveInputById(sourceId: string): void {
    const inputSource = this.inputSources.find(i => i.id === sourceId);
    if (inputSource && inputSource.identifier !== this.currentInputId) {
      this.currentInputId = inputSource.identifier;
      this.markPending(inputSource.identifier);
      if (this.tvService) {
        this.tvService.updateCharacteristic(this.deps.Characteristic.ActiveIdentifier, this.currentInputId);
      }
      this.deps.log('debug', `Input updated: ${inputSource.name}`);
    }
  }

  /** Record a manual switch so contradicting polls are ignored for a while. */
  private markPending(identifier: number): void {
    this.pendingInputId = identifier;
    this.pendingSince = Date.now();
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

    // Coalesce bursts of wheel moves: launches run one at a time, and a
    // selection that is superseded while waiting is skipped entirely. Without
    // this, every intermediate selection launched on the TV back-to-back —
    // the requests piled up until the newest (the one the user actually
    // wanted) was dropped by the client queue or blew HomeKit's 10s callback
    // deadline, leaving the wheel showing "No Response" until reopened.
    const generation = ++this.switchGeneration;
    const task = this.switchQueue.then(async () => {
      if (generation !== this.switchGeneration) {
        this.deps.log('debug', `Skipping superseded switch to ${inputSource.name}`);
        return;
      }
      await this.performSwitch(inputSource);
    });
    this.switchQueue = task.then(() => {}, () => {});
    return task;
  }

  private async performSwitch(inputSource: InputSource): Promise<void> {
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
    const inputSource = this.inputSources.find(i => i.id === this.resolveReportedApp(currentApp));
    if (!inputSource) {
      return null;
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
    if (LAUNCHER_PACKAGES.has(app)) {
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
    return app;
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
