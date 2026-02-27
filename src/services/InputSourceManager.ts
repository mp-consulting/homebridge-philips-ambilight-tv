import type { CharacteristicValue, HapStatusError, PlatformAccessory, Service } from 'homebridge';

import type { PhilipsTVClient } from '../api/PhilipsTVClient.js';
import { HDMI_SOURCES, WATCH_TV_URI } from '../api/PhilipsTVClient.js';
import type { RemoteKey } from '../api/types.js';
import { sanitizeForHomeKit } from '../api/utils.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Maximum number of input sources allowed by HomeKit */
const MAX_INPUT_SOURCES = 15;

/** Fallback apps when TV is unreachable */
const FALLBACK_APPS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'com.google.android.tvlauncher', name: 'Home' },
  { id: 'com.google.android.youtube.tv', name: 'YouTube' },
  { id: 'com.netflix.ninja', name: 'Netflix' },
  { id: 'com.disney.disneyplus', name: 'Disney Plus' },
  { id: 'com.amazon.amazonvideo.livingroom', name: 'Prime Video' },
];

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
}

/** Persisted input source configuration (stored in accessory context) */
interface InputSourceConfig {
  readonly id: string;
  readonly name: string;
  readonly configuredName: string;
  readonly type: InputType;
  readonly identifier: number;
  readonly visibility: number;
}

/** Raw input data before HomeKit service creation */
interface InputData {
  readonly id: string;
  readonly name: string;
  readonly type: InputType;
}

// ============================================================================
// DEPENDENCIES
// ============================================================================

export interface InputSourceManagerDeps {
  readonly Service: typeof Service;
  readonly Characteristic: typeof import('homebridge').Characteristic;
  readonly tvClient: PhilipsTVClient;
  readonly accessory: PlatformAccessory;
  readonly communicationError: () => HapStatusError;
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

// ============================================================================
// INPUT SOURCE MANAGER
// ============================================================================

export class InputSourceManager {
  private inputSources: InputSource[] = [];
  private currentInputId = 1;

  constructor(private readonly deps: InputSourceManagerDeps) {}

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
   * Synchronously configure input sources with static sources (HDMI) and fallback apps.
   * This ensures HomeKit sees the input sources immediately on startup.
   */
  configureInputSources(tvService: Service): void {
    const staticInputs = this.getStaticInputSources();
    const cachedConfigs = this.getCachedInputConfigs();

    this.removeStaleInputSources(staticInputs);

    staticInputs.forEach((input, index) => {
      const identifier = index + 1;
      const cached = cachedConfigs.find(c => c.id === input.id);
      const inputSource = this.restoreOrCreateInputSource(input, identifier, cached, tvService);
      this.inputSources.push(inputSource);
    });

    this.saveInputConfigs();
    this.deps.log('info', `Configured ${this.inputSources.length} input sources`);
  }

  /**
   * Fetch applications from TV asynchronously.
   */
  async fetchAppsFromTV(): Promise<void> {
    try {
      const tvApps = await this.deps.tvClient.getApplications();
      if (tvApps.length > 0) {
        this.deps.log('debug', `Fetched ${tvApps.length} apps from TV`);
      }
    } catch {
      this.deps.log('debug', 'TV not reachable, using fallback apps');
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
  // PRIVATE HELPERS
  // ==========================================================================

  private getStaticInputSources(): InputData[] {
    const inputs: InputData[] = [];

    inputs.push({ id: WATCH_TV_URI, name: 'Watch TV', type: 'source' });
    for (const [id, name] of Object.entries(HDMI_SOURCES)) {
      inputs.push({ id, name, type: 'source' });
    }

    for (const app of FALLBACK_APPS) {
      if (inputs.length >= MAX_INPUT_SOURCES) {
        break;
      }
      inputs.push({ ...app, type: 'app' });
    }

    return inputs.slice(0, MAX_INPUT_SOURCES);
  }

  private getCachedInputConfigs(): InputSourceConfig[] {
    return this.deps.accessory.context.inputConfigs || [];
  }

  private saveInputConfigs(): void {
    const { Characteristic: Char } = this.deps;
    this.deps.accessory.context.inputConfigs = this.inputSources.map(input => ({
      id: input.id,
      name: input.name,
      configuredName: input.service.getCharacteristic(Char.ConfiguredName).value as string,
      type: input.type,
      identifier: input.identifier,
      visibility: input.service.getCharacteristic(Char.CurrentVisibilityState).value as number,
    }));
  }

  private removeStaleInputSources(currentInputs: InputData[]): void {
    const { Service: Svc } = this.deps;
    const currentIds = new Set(currentInputs.map(input => input.id));

    this.deps.accessory.services
      .filter(s => s.UUID === Svc.InputSource.UUID)
      .forEach(s => {
        const subtype = s.subtype;
        const cachedConfig = this.getCachedInputConfigs().find(c => `input-${c.identifier}` === subtype);
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

    let service = this.deps.accessory.getService(subtype);

    if (service) {
      this.updateExistingInputSource(service, cached, inputSourceType);
    } else {
      service = this.createInputSourceService(subtype, defaultName, identifier, cached, inputSourceType, tvService);
    }

    this.setupInputSourceHandlers(service, defaultName);

    return { id: input.id, name: defaultName, type: input.type, identifier, service };
  }

  private updateExistingInputSource(
    service: Service,
    cached: InputSourceConfig | undefined,
    inputSourceType: number,
  ): void {
    const { Characteristic: Char } = this.deps;
    if (cached) {
      service
        .setCharacteristic(Char.ConfiguredName, cached.configuredName)
        .setCharacteristic(Char.CurrentVisibilityState, cached.visibility)
        .setCharacteristic(Char.TargetVisibilityState, cached.visibility);
    }
    service.setCharacteristic(Char.InputSourceType, inputSourceType);
  }

  private createInputSourceService(
    subtype: string,
    defaultName: string,
    identifier: number,
    cached: InputSourceConfig | undefined,
    inputSourceType: number,
    tvService: Service,
  ): Service {
    const { Service: Svc, Characteristic: Char } = this.deps;
    const configuredName = cached?.configuredName ?? defaultName;
    const visibility = cached?.visibility ?? Char.CurrentVisibilityState.SHOWN;

    const service = this.deps.accessory.addService(Svc.InputSource, configuredName, subtype);

    service.setCharacteristic(Char.Identifier, identifier);
    service.getCharacteristic(Char.ConfiguredName).setValue(configuredName);
    service.getCharacteristic(Char.Name).setValue(configuredName);

    service
      .setCharacteristic(Char.IsConfigured, Char.IsConfigured.CONFIGURED)
      .setCharacteristic(Char.InputSourceType, inputSourceType)
      .setCharacteristic(Char.CurrentVisibilityState, visibility)
      .setCharacteristic(Char.TargetVisibilityState, visibility);

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
      return this.deps.tvClient.setChannel(parseInt(input.id, 10));
    }
  }
}
