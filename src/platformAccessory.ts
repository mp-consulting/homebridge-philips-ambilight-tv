import type { CharacteristicValue, HapStatusError, PlatformAccessory, Service } from 'homebridge';

import type { PhilipsAmbilightTVPlatform } from './platform.js';
import { PhilipsTVClient } from './api/PhilipsTVClient.js';
import type { TVDeviceConfig, RemoteKey } from './api/types.js';
import { AmbilightService } from './services/AmbilightService.js';
import { InputSourceManager } from './services/InputSourceManager.js';
import { StatePollManager } from './services/StatePollManager.js';

// ============================================================================
// PHILIPS AMBILIGHT TV ACCESSORY
// ============================================================================

export class PhilipsAmbilightTVAccessory {
  private readonly tvService: Service;
  private readonly speakerService: Service;
  private readonly tvClient: PhilipsTVClient;
  private readonly config: TVDeviceConfig;

  private readonly ambilightService: AmbilightService;
  private readonly inputSourceManager: InputSourceManager;
  private readonly statePollManager: StatePollManager;

  private isPoweredOn = false;
  private isMuted = false;

  constructor(
    private readonly platform: PhilipsAmbilightTVPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.config = accessory.context.device as TVDeviceConfig;
    this.tvClient = new PhilipsTVClient(this.config, (msg) => this.log('debug', msg));

    // Create services
    this.ambilightService = new AmbilightService({
      Service: this.Service,
      Characteristic: this.Characteristic,
      tvClient: this.tvClient,
      communicationError: () => this.communicationError(),
      log: (level, msg) => this.log(level, msg),
    });

    this.inputSourceManager = new InputSourceManager({
      Service: this.Service,
      Characteristic: this.Characteristic,
      tvClient: this.tvClient,
      accessory: this.accessory,
      communicationError: () => this.communicationError(),
      log: (level, msg) => this.log(level, msg),
    });

    this.statePollManager = new StatePollManager(
      this.tvClient,
      this.config,
      {
        onPowerChange: (isOn) => this.onPowerChange(isOn),
        onAmbilightUpdate: (style, fallback) => this.ambilightService.updateFromPoll(style, fallback),
        onVolumeUpdate: (muted) => this.onMuteChange(muted),
        onInputUpdate: (app) => this.inputSourceManager.updateFromPoll(app, this.tvService),
        onAppsReady: () => this.inputSourceManager.fetchAppsFromTV(),
      },
      (level, msg) => this.log(level, msg),
    );

    // Configure HomeKit services
    this.configureAccessoryInfo();
    this.tvService = this.configureTelevisionService();
    this.speakerService = this.configureSpeakerService();
    this.ambilightService.configureService(this.accessory, this.tvService);
    this.inputSourceManager.configureInputSources(this.tvService);
    this.statePollManager.start();
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

  private communicationError(): HapStatusError {
    const { HapStatusError: HapError, HAPStatus } = this.platform.api.hap;
    return new HapError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  // ==========================================================================
  // ACCESSORY CONFIGURATION
  // ==========================================================================

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
      .onGet(() => this.inputSourceManager.handleGetInput())
      .onSet((value) => this.inputSourceManager.handleSetInput(value));

    service.getCharacteristic(this.Characteristic.RemoteKey)
      .onSet((value) => this.inputSourceManager.handleRemoteKey(value));

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
      .onGet(() => this.isMuted)
      .onSet((value) => this.handleSetMute(value));

    this.tvService.addLinkedService(service);

    return service;
  }

  // ==========================================================================
  // POWER HANDLERS
  // ==========================================================================

  private handleGetPower(): CharacteristicValue {
    return this.isPoweredOn
      ? this.Characteristic.Active.ACTIVE
      : this.Characteristic.Active.INACTIVE;
  }

  private async handleSetPower(value: CharacteristicValue): Promise<void> {
    const shouldBeOn = value === this.Characteristic.Active.ACTIVE;
    this.log('info', `Setting power to ${shouldBeOn ? 'ON' : 'OFF'}`);

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

  // ==========================================================================
  // VOLUME HANDLERS
  // ==========================================================================

  private async handleVolumeChange(value: CharacteristicValue): Promise<void> {
    const key: RemoteKey = value === 0 ? 'VolumeUp' : 'VolumeDown';
    this.log('debug', `Volume ${value === 0 ? 'up' : 'down'}`);
    try {
      await this.tvClient.sendKey(key);
    } catch {
      this.log('warn', 'Failed to change volume');
    }
  }

  private async handleSetMute(value: CharacteristicValue): Promise<void> {
    this.log('debug', `Setting mute to ${value}`);
    try {
      await this.tvClient.setMuted(value as boolean);
    } catch {
      this.log('warn', 'Failed to set mute state');
    }
  }

  // ==========================================================================
  // POLL CALLBACKS
  // ==========================================================================

  private onPowerChange(isOn: boolean): void {
    this.isPoweredOn = isOn;
    this.tvService.updateCharacteristic(
      this.Characteristic.Active,
      isOn ? this.Characteristic.Active.ACTIVE : this.Characteristic.Active.INACTIVE,
    );
    this.log('debug', `Power state updated: ${isOn ? 'ON' : 'OFF'}`);
  }

  private onMuteChange(muted: boolean): void {
    if (muted !== this.isMuted) {
      this.isMuted = muted;
      this.speakerService.updateCharacteristic(this.Characteristic.Mute, muted);
      this.log('debug', `Mute state updated: ${muted ? 'muted' : 'unmuted'}`);
    }
  }

  // ==========================================================================
  // UTILITIES
  // ==========================================================================

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.platform.log[level](`[${this.config.name}] ${message}`);
  }

  public cleanup(): void {
    this.statePollManager.cleanup();
  }
}
