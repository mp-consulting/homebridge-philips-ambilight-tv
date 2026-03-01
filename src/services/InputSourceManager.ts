import type { Characteristic, CharacteristicValue, HapStatusError, PlatformAccessory, Service } from 'homebridge';
import fs from 'fs';
import { writeFile } from 'fs/promises';
import path from 'path';

import type { PhilipsTVClient } from '../api/PhilipsTVClient.js';
import { HDMI_SOURCES, WATCH_TV_URI } from '../api/PhilipsTVClient.js';
import type { InputConfig, RemoteKey, SourceConfig } from '../api/types.js';
import { sanitizeForHomeKit } from '../api/utils.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Maximum number of input sources (static + apps). HomeKit allows up to 100
 *  services per accessory but too many causes performance issues. */
const MAX_INPUT_SOURCES = 30;

/** TLV8 tags for DisplayOrder encoding */
const TLV_ELEMENT_START = 0x01;
const TLV_ELEMENT_END = 0x00;

/** Number of static sources (Watch TV + HDMI 1-4) */
const STATIC_SOURCE_COUNT = 1 + Object.keys(HDMI_SOURCES).length;

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

/** HomeKit RemoteKey to Philips TV key mapping */
const HOMEKIT_TO_TV_KEY: Readonly<Record<number, RemoteKey>> = {
  0: 'Rewind',
  1: 'FastForward',
  2: 'Next',
  3: 'Previous',
  4: 'CursorUp',
  5: 'CursorDown',
  6: 'CursorLeft',
  7: 'CursorRight',
  8: 'Confirm',
  9: 'Back',
  10: 'Home',
  11: 'PlayPause',
  15: 'Info',
};

// ============================================================================
// TYPES
// ============================================================================

/** Input source type for HomeKit categorization */
type InputType = 'app' | 'source' | 'channel';

/** Runtime input source with associated HomeKit service */
interface InputSource {
  readonly id: string;
  readonly name: string;
  readonly type: InputType;
  readonly identifier: number;
  readonly service: Service;
  readonly channelListId?: string;
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
  readonly sourceConfigs?: SourceConfig[];
  readonly communicationError: () => HapStatusError;
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

// ============================================================================
// INPUT SOURCE MANAGER
// ============================================================================

export class InputSourceManager {
  private inputSources: InputSource[] = [];
  private currentInputId = 1;
  private tvService: Service | null = null;

  /** Source configs indexed by id for fast lookup */
  private sourceConfigMap: Map<string, SourceConfig>;

  /** File path for persisted input configs (survives restarts for external accessories) */
  private readonly inputCachePath: string;

  constructor(private readonly deps: InputSourceManagerDeps) {
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
    const allInputs = [...staticInputs, ...appInputs].slice(0, MAX_INPUT_SOURCES);

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
          return pkg && !EXCLUDED_PACKAGES.has(pkg);
        })
        .map(app => ({
          id: app.intent!.component!.packageName!,
          name: app.label || app.intent!.component!.packageName!,
          type: 'app' as const,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      // Find new apps that aren't already in our input sources
      const existingIds = new Set(this.inputSources.map(s => s.id));
      const newApps = tvAppInputs.filter(app => !existingIds.has(app.id));

      if (newApps.length === 0) {
        this.deps.log('debug', 'No new apps to add');
        return;
      }

      const available = MAX_INPUT_SOURCES - this.inputSources.length;
      const appsToAdd = newApps.slice(0, available);

      if (appsToAdd.length === 0) {
        this.deps.log('debug', `Input source limit reached (${MAX_INPUT_SOURCES})`);
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
    } catch {
      this.deps.log('debug', 'TV not reachable for app discovery');
    }
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

    try {
      const success = await this.switchInput(inputSource);
      if (success) {
        this.currentInputId = identifier;
      } else {
        throw this.deps.communicationError();
      }
    } catch (error) {
      this.deps.log('warn', 'Failed to switch input');
      throw error instanceof Error && 'hapStatus' in error ? error : this.deps.communicationError();
    }
  }

  // ==========================================================================
  // REMOTE KEY HANDLER
  // ==========================================================================

  async handleRemoteKey(value: CharacteristicValue): Promise<void> {
    const tvKey = HOMEKIT_TO_TV_KEY[value as number];

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

  updateFromPoll(currentApp: string | null, tvService: Service): void {
    if (currentApp) {
      const inputSource = this.inputSources.find(i => i.id === currentApp);
      if (inputSource && inputSource.identifier !== this.currentInputId) {
        this.currentInputId = inputSource.identifier;
        tvService.updateCharacteristic(this.deps.Characteristic.ActiveIdentifier, this.currentInputId);
        this.deps.log('debug', `Input updated: ${inputSource.name}`);
      }
    }
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

  /** Static sources that are always present: Watch TV + HDMI 1-4 */
  private getStaticSources(): InputData[] {
    const inputs: InputData[] = [];
    inputs.push({ id: WATCH_TV_URI, name: 'Watch TV', type: 'source' });
    for (const [id, name] of Object.entries(HDMI_SOURCES)) {
      inputs.push({ id, name, type: 'source' });
    }
    return inputs;
  }

  /**
   * Returns the initial set of app inputs for startup:
   * 1. If user configured inputs[] → use those
   * 2. Else if we have cached apps from a previous TV fetch → use those
   * 3. Else → empty (apps will be discovered when TV becomes reachable)
   */
  private getInitialAppInputs(): InputData[] {
    // User-configured inputs take priority
    if (this.deps.userInputs && this.deps.userInputs.length > 0) {
      return this.deps.userInputs.map(i => ({
        id: i.identifier,
        name: i.name,
        type: i.type,
      }));
    }

    // Use cached apps from a previous session (apps discovered from TV)
    const cachedApps = this.getCachedInputConfigs().filter(c => c.type === 'app');
    if (cachedApps.length > 0) {
      return cachedApps.map(c => ({
        id: c.id,
        name: c.name,
        type: c.type as InputType,
        channelListId: c.channelListId,
      }));
    }

    // No cache — start with static sources only; apps added once TV is reachable
    return [];
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

    return { id: input.id, name: defaultName, type: input.type, identifier, service, channelListId: input.channelListId };
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

        // Workaround for tvOS 18 HomeHub bug (https://github.com/homebridge/homebridge/issues/3703)
        if (/^Input Source( \d+)?$/.test(newName)) {
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
        return this.deps.tvClient.launchApplication(input.id);
      case 'source':
        return this.deps.tvClient.setSource(input.id);
      case 'channel':
        return this.deps.tvClient.setChannel(parseInt(input.id, 10), input.channelListId);
    }
  }
}
