import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { PhilipsAmbilightTVPlatform } from './platform.js';
import { PhilipsTVClient, HDMI_SOURCES, WATCH_TV_URI } from './api/PhilipsTVClient.js';
import type { TVDeviceConfig, RemoteKey } from './api/types.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Default polling interval in milliseconds */
const DEFAULT_POLLING_INTERVAL_MS = 10000;

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
// UTILITIES
// ============================================================================

/**
 * Sanitize a name for HomeKit compatibility.
 * HomeKit only allows alphanumeric, space, and apostrophe characters.
 */
function sanitizeForHomeKit(name: string): string {
  return name
    .replace(/\+/g, ' Plus')
    .replace(/&/g, ' and ')
    .replace(/@/g, ' at ')
    .replace(/#/g, ' ')
    .replace(/[^a-zA-Z0-9 ']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^a-zA-Z0-9]+/, '')
    .replace(/[^a-zA-Z0-9]+$/, '')
    || 'Unknown';
}

// ============================================================================
// PHILIPS AMBILIGHT TV ACCESSORY
// ============================================================================

export class PhilipsAmbilightTVAccessory {
  private readonly tvService: Service;
  private readonly ambilightService: Service;
  private readonly tvClient: PhilipsTVClient;
  private readonly config: TVDeviceConfig;

  private inputSources: InputSource[] = [];
  private currentInputId = 1;
  private isPoweredOn = false;
  private isAmbilightOn = false;
  private pollingTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly platform: PhilipsAmbilightTVPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.config = accessory.context.device as TVDeviceConfig;
    this.tvClient = new PhilipsTVClient(this.config);

    this.configureAccessoryInfo();
    this.tvService = this.configureTelevisionService();
    this.configureSpeakerService();
    this.ambilightService = this.configureAmbilightService();
    this.configureInputSourcesSync();
    this.startStatePolling();

    // Fetch apps from TV in background (for future dynamic updates)
    this.fetchAppsFromTV();
  }

  // ==========================================================================
  // ACCESSORS
  // ==========================================================================

  private get Service() {
    return this.platform.Service;
  }

  private get Characteristic() {
    return this.platform.Characteristic;
  }

  // ============================================================================
  // ACCESSORY CONFIGURATION
  // ============================================================================

  private configureAccessoryInfo(): void {
    this.accessory.getService(this.Service.AccessoryInformation)!
      .setCharacteristic(this.Characteristic.Manufacturer, 'Philips')
      .setCharacteristic(this.Characteristic.Model, 'Ambilight TV')
      .setCharacteristic(this.Characteristic.SerialNumber, this.config.mac);
  }

  private configureTelevisionService(): Service {
    const service = this.accessory.getService(this.Service.Television)
      ?? this.accessory.addService(this.Service.Television);

    service
      .setCharacteristic(this.Characteristic.Name, this.config.name)
      .setCharacteristic(this.Characteristic.ConfiguredName, this.config.name)
      .setCharacteristic(this.Characteristic.SleepDiscoveryMode, this.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE)
      .setCharacteristic(this.Characteristic.CurrentMediaState, this.Characteristic.CurrentMediaState.STOP);

    service.getCharacteristic(this.Characteristic.Active)
      .onGet(() => this.handleGetPower())
      .onSet((value) => this.handleSetPower(value));

    service.getCharacteristic(this.Characteristic.ActiveIdentifier)
      .onGet(() => this.handleGetInput())
      .onSet((value) => this.handleSetInput(value));

    service.getCharacteristic(this.Characteristic.RemoteKey)
      .onSet((value) => this.handleRemoteKey(value));

    return service;
  }

  private configureSpeakerService(): void {
    const service = this.accessory.getService(this.Service.TelevisionSpeaker)
      ?? this.accessory.addService(this.Service.TelevisionSpeaker);

    service
      .setCharacteristic(this.Characteristic.Active, this.Characteristic.Active.ACTIVE)
      .setCharacteristic(this.Characteristic.VolumeControlType, this.Characteristic.VolumeControlType.ABSOLUTE);

    service.getCharacteristic(this.Characteristic.VolumeSelector)
      .onSet((value) => this.handleVolumeChange(value));

    service.getCharacteristic(this.Characteristic.Mute)
      .onGet(() => this.handleGetMute())
      .onSet((value) => this.handleSetMute(value));

    this.tvService.addLinkedService(service);
  }

  private configureAmbilightService(): Service {
    const service = this.accessory.getService(this.Service.Lightbulb)
      ?? this.accessory.addService(this.Service.Lightbulb, 'Ambilight', 'ambilight');

    service.setCharacteristic(this.Characteristic.Name, 'Ambilight');

    service.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.handleGetAmbilight())
      .onSet((value) => this.handleSetAmbilight(value));

    this.tvService.addLinkedService(service);

    return service;
  }

  /**
   * Synchronously configure input sources with static sources (HDMI) and fallback apps.
   * This ensures HomeKit sees the input sources immediately on startup.
   */
  private configureInputSourcesSync(): void {
    const staticInputs = this.getStaticInputSources();
    const cachedConfigs = this.getCachedInputConfigs();

    this.removeStaleInputSources(staticInputs);

    staticInputs.forEach((input, index) => {
      const identifier = index + 1;
      const cached = cachedConfigs.find(c => c.id === input.id);
      const inputSource = this.restoreOrCreateInputSource(input, identifier, cached);
      this.inputSources.push(inputSource);
    });

    this.saveInputConfigs();
    this.log('info', `Configured ${this.inputSources.length} input sources`);
  }

  /**
   * Fetch applications from TV asynchronously.
   * Currently logs the result but doesn't update input sources dynamically.
   */
  private async fetchAppsFromTV(): Promise<void> {
    try {
      const tvApps = await this.tvClient.getApplications();
      if (tvApps.length > 0) {
        this.log('debug', `Fetched ${tvApps.length} apps from TV`);
        // Apps are available - could update input sources here in future
        // For now, we use static + fallback apps configured synchronously
      }
    } catch {
      this.log('debug', 'TV not reachable, using fallback apps');
    }
  }

  /**
   * Get static input sources (HDMI + fallback apps) synchronously.
   */
  private getStaticInputSources(): InputData[] {
    const inputs: InputData[] = [];

    // Add HDMI sources first (Watch TV + HDMI 1-4)
    inputs.push({ id: WATCH_TV_URI, name: 'Watch TV', type: 'source' });
    for (const [id, name] of Object.entries(HDMI_SOURCES)) {
      inputs.push({ id, name, type: 'source' });
    }

    // Add fallback apps
    for (const app of FALLBACK_APPS) {
      if (inputs.length >= MAX_INPUT_SOURCES) {
        break;
      }
      inputs.push({ ...app, type: 'app' });
    }

    return inputs.slice(0, MAX_INPUT_SOURCES);
  }

  private getCachedInputConfigs(): InputSourceConfig[] {
    return this.accessory.context.inputConfigs || [];
  }

  private saveInputConfigs(): void {
    this.accessory.context.inputConfigs = this.inputSources.map(input => ({
      id: input.id,
      name: input.name,
      configuredName: input.service.getCharacteristic(this.Characteristic.ConfiguredName).value as string,
      type: input.type,
      identifier: input.identifier,
      visibility: input.service.getCharacteristic(this.Characteristic.CurrentVisibilityState).value as number,
    }));
  }

  private removeStaleInputSources(currentInputs: InputData[]): void {
    const currentIds = new Set(currentInputs.map(input => input.id));

    this.accessory.services
      .filter(s => s.UUID === this.Service.InputSource.UUID)
      .forEach(s => {
        const subtype = s.subtype;
        const cachedConfig = this.getCachedInputConfigs().find(c => `input-${c.identifier}` === subtype);
        if (cachedConfig && !currentIds.has(cachedConfig.id)) {
          this.accessory.removeService(s);
        }
      });

    this.inputSources = [];
  }

  private restoreOrCreateInputSource(
    input: InputData,
    identifier: number,
    cached?: InputSourceConfig,
  ): InputSource {
    const subtype = `input-${identifier}`;
    const defaultName = sanitizeForHomeKit(input.name);

    // Determine input source type for HomeKit
    const inputSourceType = input.type === 'source'
      ? this.Characteristic.InputSourceType.HDMI
      : this.Characteristic.InputSourceType.APPLICATION;

    // Try to restore existing service or create new one
    let service = this.accessory.getService(subtype);

    if (service) {
      this.updateExistingInputSource(service, cached, inputSourceType);
    } else {
      service = this.createInputSourceService(subtype, defaultName, identifier, cached, inputSourceType);
    }

    this.setupInputSourceHandlers(service, defaultName);

    return { id: input.id, name: defaultName, type: input.type, identifier, service };
  }

  private updateExistingInputSource(
    service: Service,
    cached: InputSourceConfig | undefined,
    inputSourceType: number,
  ): void {
    if (cached) {
      service
        .setCharacteristic(this.Characteristic.ConfiguredName, cached.configuredName)
        .setCharacteristic(this.Characteristic.CurrentVisibilityState, cached.visibility)
        .setCharacteristic(this.Characteristic.TargetVisibilityState, cached.visibility);
    }
    service.setCharacteristic(this.Characteristic.InputSourceType, inputSourceType);
  }

  private createInputSourceService(
    subtype: string,
    defaultName: string,
    identifier: number,
    cached: InputSourceConfig | undefined,
    inputSourceType: number,
  ): Service {
    const configuredName = cached?.configuredName ?? defaultName;
    const visibility = cached?.visibility ?? this.Characteristic.CurrentVisibilityState.SHOWN;

    // Pass configuredName as displayName to help with tvOS 18 HomeHub renaming issue
    // See: https://github.com/homebridge/homebridge/issues/3703
    const service = this.accessory.addService(this.Service.InputSource, configuredName, subtype);

    // Set Identifier first - this is critical for HomeKit
    service.setCharacteristic(this.Characteristic.Identifier, identifier);

    // Use getCharacteristic().setValue() for ConfiguredName to ensure proper HAP notification
    service.getCharacteristic(this.Characteristic.ConfiguredName).setValue(configuredName);
    service.getCharacteristic(this.Characteristic.Name).setValue(configuredName);

    service
      .setCharacteristic(this.Characteristic.IsConfigured, this.Characteristic.IsConfigured.CONFIGURED)
      .setCharacteristic(this.Characteristic.InputSourceType, inputSourceType)
      .setCharacteristic(this.Characteristic.CurrentVisibilityState, visibility)
      .setCharacteristic(this.Characteristic.TargetVisibilityState, visibility);

    this.tvService.addLinkedService(service);
    return service;
  }

  private setupInputSourceHandlers(service: Service, originalName: string): void {
    // Store the valid name for this input
    let validName = service.getCharacteristic(this.Characteristic.ConfiguredName).value as string || originalName;

    service.getCharacteristic(this.Characteristic.ConfiguredName)
      .onGet(() => validName)
      .onSet((value) => {
        const newName = value as string;

        // Workaround for tvOS 18 HomeHub bug (https://github.com/homebridge/homebridge/issues/3703)
        // Reject generic "Input Source X" names that the Apple TV HomeHub tries to set
        if (/^Input Source( \d+)?$/.test(newName)) {
          // Silently ignore - don't log to reduce spam
          return;
        }

        validName = newName;
        this.log('debug', `Input renamed to: ${newName}`);
        this.saveInputConfigs();
      });

    service.getCharacteristic(this.Characteristic.TargetVisibilityState)
      .onSet((value) => {
        service.setCharacteristic(this.Characteristic.CurrentVisibilityState, value as number);
        this.log('debug', `Input visibility changed: ${value === 0 ? 'shown' : 'hidden'}`);
        this.saveInputConfigs();
      });
  }


  // ============================================================================
  // POWER HANDLERS
  // ============================================================================

  private async handleGetPower(): Promise<CharacteristicValue> {
    this.log('debug', 'Getting power state');

    try {
      this.isPoweredOn = await this.tvClient.getPowerState();
    } catch {
      this.log('debug', 'Failed to get power state');
    }

    return this.isPoweredOn
      ? this.Characteristic.Active.ACTIVE
      : this.Characteristic.Active.INACTIVE;
  }

  private async handleSetPower(value: CharacteristicValue): Promise<void> {
    const shouldBeOn = value === this.Characteristic.Active.ACTIVE;
    this.log('info', `Setting power to ${shouldBeOn ? 'ON' : 'OFF'}`);

    // Skip if already in desired state
    if (shouldBeOn === this.isPoweredOn) {
      this.log('debug', 'Already in desired power state');
      return;
    }

    const success = await this.tvClient.setPowerState(shouldBeOn);
    if (success) {
      this.isPoweredOn = shouldBeOn;
      this.log('debug', `Power state changed to ${shouldBeOn ? 'ON' : 'OFF'}`);
    } else {
      this.log('warn', 'Failed to change power state');
    }
  }

  // ============================================================================
  // INPUT HANDLERS
  // ============================================================================

  private async handleGetInput(): Promise<CharacteristicValue> {
    this.log('debug', 'Getting active input');

    try {
      const currentApp = await this.tvClient.getCurrentActivity();
      const inputSource = this.inputSources.find(i => i.id === currentApp);
      if (inputSource) {
        this.currentInputId = inputSource.identifier;
      }
    } catch {
      this.log('debug', 'Failed to get current activity');
    }

    return this.currentInputId;
  }

  private async handleSetInput(value: CharacteristicValue): Promise<void> {
    const identifier = value as number;
    const inputSource = this.inputSources.find(i => i.identifier === identifier);

    if (!inputSource) {
      this.log('warn', `Unknown input identifier: ${identifier}`);
      return;
    }

    this.log('info', `Switching to: ${inputSource.name}`);

    const success = await this.switchInput(inputSource);
    if (success) {
      this.currentInputId = identifier;
    } else {
      this.log('warn', 'Failed to switch input');
    }
  }

  private async switchInput(input: InputSource): Promise<boolean> {
    switch (input.type) {
    case 'app':
      return this.tvClient.launchApplication(input.id);
    case 'source':
      return this.tvClient.setSource(input.id);
    case 'channel':
      return this.tvClient.setChannel(parseInt(input.id, 10));
    }
  }

  // ============================================================================
  // REMOTE KEY HANDLER
  // ============================================================================

  private async handleRemoteKey(value: CharacteristicValue): Promise<void> {
    const tvKey = HOMEKIT_TO_TV_KEY[value as number];

    if (!tvKey) {
      this.log('debug', `Unknown remote key: ${value}`);
      return;
    }

    this.log('debug', `Remote key: ${tvKey}`);

    const success = await this.tvClient.sendKey(tvKey);
    if (!success) {
      this.log('warn', 'Failed to send remote key');
    }
  }

  // ============================================================================
  // VOLUME HANDLERS
  // ============================================================================

  private async handleVolumeChange(value: CharacteristicValue): Promise<void> {
    const key: RemoteKey = value === 0 ? 'VolumeUp' : 'VolumeDown';
    this.log('debug', `Volume ${value === 0 ? 'up' : 'down'}`);
    await this.tvClient.sendKey(key);
  }

  private async handleGetMute(): Promise<CharacteristicValue> {
    try {
      const volume = await this.tvClient.getVolume();
      return volume?.muted ?? false;
    } catch {
      return false;
    }
  }

  private async handleSetMute(value: CharacteristicValue): Promise<void> {
    this.log('debug', `Setting mute to ${value}`);
    await this.tvClient.setMuted(value as boolean);
  }

  // ============================================================================
  // AMBILIGHT HANDLERS
  // ============================================================================

  private async handleGetAmbilight(): Promise<CharacteristicValue> {
    this.log('debug', 'Getting Ambilight state');

    try {
      this.isAmbilightOn = await this.tvClient.getAmbilightPower();
    } catch {
      this.log('debug', 'Failed to get Ambilight state');
    }

    return this.isAmbilightOn;
  }

  private async handleSetAmbilight(value: CharacteristicValue): Promise<void> {
    const shouldBeOn = value as boolean;
    this.log('info', `Setting Ambilight to ${shouldBeOn ? 'ON' : 'OFF'}`);

    const success = await this.tvClient.setAmbilightPower(shouldBeOn);
    if (success) {
      this.isAmbilightOn = shouldBeOn;
    } else {
      this.log('warn', 'Failed to change Ambilight state');
    }
  }

  // ============================================================================
  // STATE POLLING
  // ============================================================================

  private startStatePolling(): void {
    const interval = this.config.pollingInterval ?? DEFAULT_POLLING_INTERVAL_MS;

    this.pollingTimer = setInterval(() => this.pollState(), interval);
    this.log('debug', `Started polling every ${interval}ms`);

    // Initial poll
    this.pollState();
  }

  private async pollState(): Promise<void> {
    try {
      const isOn = await this.tvClient.getPowerState();
      if (isOn !== this.isPoweredOn) {
        this.isPoweredOn = isOn;
        this.tvService.updateCharacteristic(
          this.Characteristic.Active,
          isOn
            ? this.Characteristic.Active.ACTIVE
            : this.Characteristic.Active.INACTIVE,
        );
        this.log('debug', `Power state updated: ${isOn ? 'ON' : 'OFF'}`);
      }

      // Poll Ambilight state only if TV is on
      if (isOn) {
        const ambilightOn = await this.tvClient.getAmbilightPower();
        if (ambilightOn !== this.isAmbilightOn) {
          this.isAmbilightOn = ambilightOn;
          this.ambilightService.updateCharacteristic(this.Characteristic.On, ambilightOn);
          this.log('debug', `Ambilight state updated: ${ambilightOn ? 'ON' : 'OFF'}`);
        }
      }
    } catch {
      // TV might be off or unreachable - this is expected
    }
  }

  // ============================================================================
  // UTILITIES
  // ============================================================================

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.platform.log[level](`[${this.config.name}] ${message}`);
  }

  public cleanup(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }
  }
}
