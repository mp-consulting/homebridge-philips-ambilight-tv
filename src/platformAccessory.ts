import type { CharacteristicValue, HapStatusError, PlatformAccessory, Service } from 'homebridge';

import type { PhilipsAmbilightTVPlatform } from './platform.js';
import { PhilipsTVClient, HDMI_SOURCES, WATCH_TV_URI } from './api/PhilipsTVClient.js';
import type { TVDeviceConfig, RemoteKey, AmbilightColor } from './api/types.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Default polling interval in milliseconds */
const DEFAULT_POLLING_INTERVAL_MS = 10000;

/** Delay before first poll after accessory creation (ms) */
const INITIAL_POLL_DELAY_MS = 5000;

/** Maximum number of input sources allowed by HomeKit */
const MAX_INPUT_SOURCES = 15;

/** HomeKit color ranges */
const HOMEKIT_HUE_MAX = 360;
const HOMEKIT_SATURATION_MAX = 100;
const HOMEKIT_BRIGHTNESS_MAX = 100;

/** Philips Ambilight color ranges */
const PHILIPS_COLOR_MAX = 255;

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
  private readonly speakerService: Service;
  private readonly ambilightService: Service;
  private readonly tvClient: PhilipsTVClient;
  private readonly config: TVDeviceConfig;

  private inputSources: InputSource[] = [];
  private currentInputId = 1;
  private isPoweredOn = false;
  private isAmbilightOn = false;
  private ambilightBrightness = 100; // 0-100 for HomeKit
  private ambilightHue = 0;          // 0-360 for HomeKit
  private ambilightSaturation = 0;   // 0-100 for HomeKit
  private isMuted = false;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private pollingTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly platform: PhilipsAmbilightTVPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.config = accessory.context.device as TVDeviceConfig;
    this.tvClient = new PhilipsTVClient(this.config, (msg) => this.log('debug', msg));

    this.configureAccessoryInfo();
    this.tvService = this.configureTelevisionService();
    this.speakerService = this.configureSpeakerService();
    this.ambilightService = this.configureAmbilightService();
    this.configureInputSourcesSync();
    this.startStatePolling();
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

  /** Create a HapStatusError for service communication failure */
  private communicationError(): HapStatusError {
    const { HapStatusError: HapError, HAPStatus } = this.platform.api.hap;
    return new HapError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
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

  private configureSpeakerService(): Service {
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

    return service;
  }

  private configureAmbilightService(): Service {
    const service = this.accessory.getService(this.Service.Lightbulb)
      ?? this.accessory.addService(this.Service.Lightbulb, 'Ambilight', 'ambilight');

    service.setCharacteristic(this.Characteristic.Name, 'Ambilight');

    // On/Off control
    service.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.handleGetAmbilight())
      .onSet((value) => this.handleSetAmbilight(value));

    // Brightness control (0-100)
    service.getCharacteristic(this.Characteristic.Brightness)
      .onGet(() => this.handleGetAmbilightBrightness())
      .onSet((value) => this.handleSetAmbilightBrightness(value));

    // Hue control (0-360)
    service.getCharacteristic(this.Characteristic.Hue)
      .onGet(() => this.handleGetAmbilightHue())
      .onSet((value) => this.handleSetAmbilightHue(value));

    // Saturation control (0-100)
    service.getCharacteristic(this.Characteristic.Saturation)
      .onGet(() => this.handleGetAmbilightSaturation())
      .onSet((value) => this.handleSetAmbilightSaturation(value));

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

  private handleGetPower(): CharacteristicValue {
    // Return cached state immediately to avoid Homebridge timeout warnings
    // Actual state is updated via polling
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

    try {
      const success = await this.tvClient.setPowerState(shouldBeOn);
      if (success) {
        this.isPoweredOn = shouldBeOn;
        this.log('debug', `Power state changed to ${shouldBeOn ? 'ON' : 'OFF'}`);
      } else {
        throw this.communicationError();
      }
    } catch (error) {
      this.log('warn', 'Failed to change power state');
      throw error instanceof this.platform.api.hap.HapStatusError ? error : this.communicationError();
    }
  }

  // ============================================================================
  // INPUT HANDLERS
  // ============================================================================

  private handleGetInput(): CharacteristicValue {
    // Return cached state immediately to avoid Homebridge timeout warnings
    // Actual state is updated via polling
    return this.currentInputId;
  }

  private async handleSetInput(value: CharacteristicValue): Promise<void> {
    const identifier = value as number;
    const inputSource = this.inputSources.find(i => i.identifier === identifier);

    if (!inputSource) {
      this.log('warn', `Unknown input identifier: ${identifier}`);
      throw this.communicationError();
    }

    this.log('info', `Switching to: ${inputSource.name}`);

    try {
      const success = await this.switchInput(inputSource);
      if (success) {
        this.currentInputId = identifier;
      } else {
        throw this.communicationError();
      }
    } catch (error) {
      this.log('warn', 'Failed to switch input');
      throw error instanceof this.platform.api.hap.HapStatusError ? error : this.communicationError();
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

    try {
      const success = await this.tvClient.sendKey(tvKey);
      if (!success) {
        this.log('warn', 'Failed to send remote key');
      }
    } catch {
      this.log('warn', 'Failed to send remote key');
    }
  }

  // ============================================================================
  // VOLUME HANDLERS
  // ============================================================================

  private async handleVolumeChange(value: CharacteristicValue): Promise<void> {
    const key: RemoteKey = value === 0 ? 'VolumeUp' : 'VolumeDown';
    this.log('debug', `Volume ${value === 0 ? 'up' : 'down'}`);
    try {
      await this.tvClient.sendKey(key);
    } catch {
      this.log('warn', 'Failed to change volume');
    }
  }

  private handleGetMute(): CharacteristicValue {
    // Return cached state immediately to avoid Homebridge timeout warnings
    // Actual state is updated via polling
    return this.isMuted;
  }

  private async handleSetMute(value: CharacteristicValue): Promise<void> {
    this.log('debug', `Setting mute to ${value}`);
    try {
      await this.tvClient.setMuted(value as boolean);
    } catch {
      this.log('warn', 'Failed to set mute state');
    }
  }

  // ============================================================================
  // AMBILIGHT HANDLERS
  // ============================================================================

  private handleGetAmbilight(): CharacteristicValue {
    // Return cached state immediately to avoid Homebridge timeout warnings
    // Actual state is updated via polling
    return this.isAmbilightOn;
  }

  private async handleSetAmbilight(value: CharacteristicValue): Promise<void> {
    const shouldBeOn = value as boolean;
    this.log('info', `Setting Ambilight to ${shouldBeOn ? 'ON' : 'OFF'}`);

    try {
      let success: boolean;
      if (shouldBeOn) {
        // When turning on, set to Follow Color mode with current color
        const color = this.homekitToPhilipsColor(this.ambilightHue, this.ambilightSaturation, this.ambilightBrightness);
        success = await this.tvClient.setAmbilightFollowColor(color);
      } else {
        success = await this.tvClient.setAmbilightOff();
      }

      if (success) {
        this.isAmbilightOn = shouldBeOn;
      } else {
        throw this.communicationError();
      }
    } catch (error) {
      this.log('warn', 'Failed to change Ambilight state');
      throw error instanceof this.platform.api.hap.HapStatusError ? error : this.communicationError();
    }
  }

  private handleGetAmbilightBrightness(): CharacteristicValue {
    return this.ambilightBrightness;
  }

  private async handleSetAmbilightBrightness(value: CharacteristicValue): Promise<void> {
    const brightness = value as number;
    this.log('debug', `Setting Ambilight brightness to ${brightness}%`);

    this.ambilightBrightness = brightness;

    // Update the color with new brightness
    if (this.isAmbilightOn) {
      try {
        const color = this.homekitToPhilipsColor(this.ambilightHue, this.ambilightSaturation, brightness);
        await this.tvClient.setAmbilightFollowColor(color);
      } catch {
        this.log('warn', 'Failed to update Ambilight brightness');
      }
    }
  }

  private handleGetAmbilightHue(): CharacteristicValue {
    return this.ambilightHue;
  }

  private async handleSetAmbilightHue(value: CharacteristicValue): Promise<void> {
    const hue = value as number;
    this.log('debug', `Setting Ambilight hue to ${hue}`);

    this.ambilightHue = hue;

    // Update the color with new hue
    if (this.isAmbilightOn) {
      try {
        const color = this.homekitToPhilipsColor(hue, this.ambilightSaturation, this.ambilightBrightness);
        await this.tvClient.setAmbilightFollowColor(color);
      } catch {
        this.log('warn', 'Failed to update Ambilight hue');
      }
    }
  }

  private handleGetAmbilightSaturation(): CharacteristicValue {
    return this.ambilightSaturation;
  }

  private async handleSetAmbilightSaturation(value: CharacteristicValue): Promise<void> {
    const saturation = value as number;
    this.log('debug', `Setting Ambilight saturation to ${saturation}%`);

    this.ambilightSaturation = saturation;

    // Update the color with new saturation
    if (this.isAmbilightOn) {
      try {
        const color = this.homekitToPhilipsColor(this.ambilightHue, saturation, this.ambilightBrightness);
        await this.tvClient.setAmbilightFollowColor(color);
      } catch {
        this.log('warn', 'Failed to update Ambilight saturation');
      }
    }
  }

  /**
   * Convert HomeKit HSB values to Philips Ambilight color format
   * HomeKit: Hue 0-360, Saturation 0-100, Brightness 0-100
   * Philips: Hue 0-255, Saturation 0-255, Brightness 0-255
   */
  private homekitToPhilipsColor(hue: number, saturation: number, brightness: number): AmbilightColor {
    return {
      hue: Math.round((hue / HOMEKIT_HUE_MAX) * PHILIPS_COLOR_MAX),
      saturation: Math.round((saturation / HOMEKIT_SATURATION_MAX) * PHILIPS_COLOR_MAX),
      brightness: Math.round((brightness / HOMEKIT_BRIGHTNESS_MAX) * PHILIPS_COLOR_MAX),
    };
  }

  /**
   * Convert Philips Ambilight color format to HomeKit HSB values
   * Philips: Hue 0-255, Saturation 0-255, Brightness 0-255
   * HomeKit: Hue 0-360, Saturation 0-100, Brightness 0-100
   */
  private philipsToHomekitColor(color: AmbilightColor): { hue: number; saturation: number; brightness: number } {
    return {
      hue: Math.round((color.hue / PHILIPS_COLOR_MAX) * HOMEKIT_HUE_MAX),
      saturation: Math.round((color.saturation / PHILIPS_COLOR_MAX) * HOMEKIT_SATURATION_MAX),
      brightness: Math.round((color.brightness / PHILIPS_COLOR_MAX) * HOMEKIT_BRIGHTNESS_MAX),
    };
  }

  // ============================================================================
  // STATE POLLING
  // ============================================================================

  private startStatePolling(): void {
    const interval = this.config.pollingInterval ?? DEFAULT_POLLING_INTERVAL_MS;

    // Delay the first poll to let the TV API stabilize after plugin load
    this.startupTimer = setTimeout(async () => {
      await this.pollState();
      this.fetchAppsFromTV();
      this.pollingTimer = setInterval(() => this.pollState(), interval);
    }, INITIAL_POLL_DELAY_MS);

    this.log('debug', `Polling will start in ${INITIAL_POLL_DELAY_MS}ms, then every ${interval}ms`);
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

      // Poll additional states only if TV is on
      if (isOn) {
        // Ambilight state and style
        const ambilightStyle = await this.tvClient.getAmbilightStyle();
        if (ambilightStyle) {
          const ambilightOn = ambilightStyle.styleName !== 'OFF';

          if (ambilightOn !== this.isAmbilightOn) {
            this.isAmbilightOn = ambilightOn;
            this.ambilightService.updateCharacteristic(this.Characteristic.On, ambilightOn);
            this.log('debug', `Ambilight state updated: ${ambilightOn ? 'ON' : 'OFF'}`);
          }

          // Update color if in FOLLOW_COLOR mode
          if (ambilightStyle.styleName === 'FOLLOW_COLOR' && ambilightStyle.colorSettings?.color) {
            const homeKitColor = this.philipsToHomekitColor(ambilightStyle.colorSettings.color);

            if (homeKitColor.hue !== this.ambilightHue) {
              this.ambilightHue = homeKitColor.hue;
              this.ambilightService.updateCharacteristic(this.Characteristic.Hue, homeKitColor.hue);
            }
            if (homeKitColor.saturation !== this.ambilightSaturation) {
              this.ambilightSaturation = homeKitColor.saturation;
              this.ambilightService.updateCharacteristic(this.Characteristic.Saturation, homeKitColor.saturation);
            }
            if (homeKitColor.brightness !== this.ambilightBrightness) {
              this.ambilightBrightness = homeKitColor.brightness;
              this.ambilightService.updateCharacteristic(this.Characteristic.Brightness, homeKitColor.brightness);
            }
          }
        } else {
          // Fallback to simple power check if style endpoint fails
          const ambilightOn = await this.tvClient.getAmbilightPower();
          if (ambilightOn !== this.isAmbilightOn) {
            this.isAmbilightOn = ambilightOn;
            this.ambilightService.updateCharacteristic(this.Characteristic.On, ambilightOn);
            this.log('debug', `Ambilight state updated: ${ambilightOn ? 'ON' : 'OFF'}`);
          }
        }

        // Mute state
        const volume = await this.tvClient.getVolume();
        if (volume) {
          const muted = volume.muted ?? false;
          if (muted !== this.isMuted) {
            this.isMuted = muted;
            this.speakerService.updateCharacteristic(this.Characteristic.Mute, muted);
            this.log('debug', `Mute state updated: ${muted ? 'muted' : 'unmuted'}`);
          }
        }

        // Current input/activity
        const currentApp = await this.tvClient.getCurrentActivity();
        if (currentApp) {
          const inputSource = this.inputSources.find(i => i.id === currentApp);
          if (inputSource && inputSource.identifier !== this.currentInputId) {
            this.currentInputId = inputSource.identifier;
            this.tvService.updateCharacteristic(this.Characteristic.ActiveIdentifier, this.currentInputId);
            this.log('debug', `Input updated: ${inputSource.name}`);
          }
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
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
    }
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }
  }
}
