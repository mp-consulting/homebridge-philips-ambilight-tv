import type { CharacteristicValue, HapStatusError, PlatformAccessory, Service } from 'homebridge';

import type { PhilipsAmbilightTVPlatform } from './platform.js';
import { PhilipsTVClient } from './api/PhilipsTVClient.js';
import { sanitizeForHomeKit } from './api/utils.js';
import type { TVDeviceConfig, AmbilightCached, RemoteKey } from './api/types.js';
import { AmbilightService } from './services/AmbilightService.js';
import { InputSourceManager } from './services/InputSourceManager.js';
import { StatePollManager } from './services/StatePollManager.js';
import { SourceSwitchService } from './services/SourceSwitchService.js';
import { StateSensorService } from './services/StateSensorService.js';
import { AmbilightHueSwitchService } from './services/AmbilightHueSwitchService.js';

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
  private readonly sourceSwitchService: SourceSwitchService;
  private readonly statePollManager: StatePollManager;
  private readonly stateSensorService: StateSensorService;
  private readonly ambilightHueSwitchService: AmbilightHueSwitchService;

  private isPoweredOn = false;
  private isMuted = false;
  private powerSynced = false;

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
      AdaptiveLightingController: platform.api.hap.AdaptiveLightingController,
      ColorUtils: platform.api.hap.ColorUtils,
      tvClient: this.tvClient,
      accessory: this.accessory,
      ambilightMode: this.config.ambilightMode,
      communicationError: () => this.communicationError(),
      log: (level, msg) => this.log(level, msg),
    });

    this.inputSourceManager = new InputSourceManager({
      Service: this.Service,
      Characteristic: this.Characteristic,
      tvClient: this.tvClient,
      accessory: this.accessory,
      storagePath: platform.api.user.storagePath(),
      deviceId: this.config.mac,
      userInputs: this.config.inputs,
      customApps: this.config.customApps,
      sourceConfigs: this.config.sources,
      infoButtonKey: this.config.infoButtonKey,
      backButtonKey: this.config.backButtonKey,
      playPauseButtonKey: this.config.playPauseButtonKey,
      communicationError: () => this.communicationError(),
      log: (level, msg) => this.log(level, msg),
      onInputsChanged: () => this.refreshSourceSwitches(),
      onInputSwitched: (sourceId) => this.sourceSwitchService.updateFromPoll(sourceId),
    });

    this.sourceSwitchService = new SourceSwitchService({
      Service: this.Service,
      Characteristic: this.Characteristic,
      tvClient: this.tvClient,
      storagePath: platform.api.user.storagePath(),
      deviceId: this.config.mac,
      communicationError: () => this.communicationError(),
      log: (level, msg) => this.log(level, msg),
      onSourceSwitch: (sourceId) => this.inputSourceManager.setActiveInputById(sourceId),
    });

    this.stateSensorService = new StateSensorService({
      Service: this.Service,
      Characteristic: this.Characteristic,
      log: (level, msg) => this.log(level, msg),
    });

    this.ambilightHueSwitchService = new AmbilightHueSwitchService({
      Service: this.Service,
      Characteristic: this.Characteristic,
      tvClient: this.tvClient,
      communicationError: () => this.communicationError(),
      log: (level, msg) => this.log(level, msg),
    });

    this.statePollManager = new StatePollManager(
      this.tvClient,
      this.config,
      {
        onPowerChange: (isOn) => this.onPowerChange(isOn),
        onAmbilightUpdate: (style, fallback) => this.onAmbilightUpdate(style, fallback),
        onVolumeUpdate: (muted) => this.onMuteChange(muted),
        onInputUpdate: (app) => this.applyInputReport(app),
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

    // Configure source switches (individual Switch services for HomeKit automations)
    this.refreshSourceSwitches();

    // Configure state sensors (MotionSensor services for HomeKit automations)
    const sensorTypes = this.config.stateSensors ?? [];
    this.stateSensorService.configureSensors(this.accessory, sensorTypes, sanitizeForHomeKit(this.config.name));

    // Configure the Ambilight + Hue switch (independent toggle for Hue integration)
    if (this.config.ambilightHueSwitch) {
      this.ambilightHueSwitchService.configureSwitch(this.accessory, sanitizeForHomeKit(this.config.name));
    } else {
      this.ambilightHueSwitchService.removeSwitch(this.accessory);
    }

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

    const displayName = sanitizeForHomeKit(this.config.name);
    service
      .setCharacteristic(this.Characteristic.Active, this.Characteristic.Active.INACTIVE)
      .setCharacteristic(this.Characteristic.ActiveIdentifier, 1)
      .setCharacteristic(this.Characteristic.Name, displayName)
      .setCharacteristic(this.Characteristic.ConfiguredName, displayName)
      .setCharacteristic(this.Characteristic.SleepDiscoveryMode, this.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE)
      .setCharacteristic(this.Characteristic.CurrentMediaState, this.Characteristic.CurrentMediaState.INTERRUPTED);

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

  /**
   * (Re)build the source-switch services from the current visible inputs.
   * Called once at setup and again whenever the input list changes (e.g. apps
   * discovered after the TV wakes) so the switch count always matches the
   * user's visible selection.
   */
  private refreshSourceSwitches(): void {
    if (!this.config.sourceSwitches) {
      return;
    }
    const tvName = sanitizeForHomeKit(this.config.name);
    const sources = this.inputSourceManager.getVisibleSources().map(s => ({
      id: s.id, name: s.name, type: s.type, channelListId: s.channelListId, className: s.className, action: s.action,
    }));
    this.sourceSwitchService.configureSwitches(this.accessory, sources, tvName);
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
        // Reflect a power-off immediately instead of waiting for the next poll
        // (up to the polling interval away), so the source switches don't linger
        // ON for several seconds after the user turns the TV off from HomeKit.
        if (!shouldBeOn) {
          this.onPowerChange(false);
        }
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
    const muted = value as boolean;
    this.log('debug', `Setting mute to ${muted}`);
    try {
      const success = await this.tvClient.sendKey('Mute');
      if (success) {
        this.isMuted = muted;
        this.stateSensorService.update('mute', muted);
      }
    } catch {
      this.log('warn', 'Failed to set mute state');
    }
  }

  // ==========================================================================
  // POLL CALLBACKS
  // ==========================================================================

  private onPowerChange(isOn: boolean): void {
    // Skip the first sync so a Homebridge restart while the TV is already on
    // doesn't count as a power-on event (which would force Ambilight on).
    const isInitialSync = !this.powerSynced;
    this.powerSynced = true;
    this.isPoweredOn = isOn;
    this.tvService.updateCharacteristic(
      this.Characteristic.Active,
      isOn ? this.Characteristic.Active.ACTIVE : this.Characteristic.Active.INACTIVE,
    );
    this.stateSensorService.update('power', isOn);
    if (!isOn) {
      this.ambilightService.reflectPowerOff();
      this.stateSensorService.update('ambilight', false);
      this.stateSensorService.update('mute', false);
      this.sourceSwitchService.resetAll();
      this.ambilightHueSwitchService.reset();
    } else if (!isInitialSync) {
      // TV just powered on. A TV that was asleep at boot may not have reported
      // its apps yet, so reconcile the input list now that it is reachable —
      // this backfills any sources that couldn't be discovered at startup and
      // refreshes the source switches to match (no restart required). Then pull
      // the current source so the right input/switch lights up immediately
      // rather than after the next poll (which can show the wrong/no switch).
      void this.syncActiveSourceOnPowerOn();
      if (this.config.ambilightOnStart) {
        // Auto-start Ambilight in the configured mode.
        void this.ambilightService.startWithConfiguredMode();
      }
    }
    this.log('debug', `Power state updated: ${isOn ? 'ON' : 'OFF'}`);
  }

  /**
   * On power-on, reconcile the input list and then apply the TV's current
   * source right away. The source switches were just reset by the preceding
   * power-off, so without this the correct switch/input only lights up on the
   * next poll cycle (up to the polling interval away).
   */
  private async syncActiveSourceOnPowerOn(): Promise<void> {
    await this.inputSourceManager.fetchAppsFromTV();
    try {
      const accepted = this.applyInputReport(await this.tvClient.getCurrentActivity());
      if (!accepted) {
        // An ambiguous system report (NA/playtv) needs a second consecutive
        // sighting before it is applied — read again after a short settle so
        // a TV that wakes onto its home screen still aligns right away.
        await new Promise(resolve => setTimeout(resolve, 2500));
        this.applyInputReport(await this.tvClient.getCurrentActivity());
      }
    } catch {
      // TV not reachable yet — the periodic poll will sync shortly.
    }
  }

  /**
   * Route a reported current app through the input manager, which resolves
   * system packages (launcher → Home, playtv → Watch TV/HDMI) and suppresses
   * reports that contradict a manual switch still in flight. Only an accepted
   * report reaches the source switches, so wheel, switches and TV stay aligned
   * instead of the switches bouncing back mid-switch. Returns the accepted
   * source id, or null when the report was suppressed or unusable.
   */
  private applyInputReport(app: string | null): string | null {
    const accepted = this.inputSourceManager.updateFromPoll(app, this.tvService);
    if (accepted) {
      this.sourceSwitchService.updateFromPoll(accepted);
    }
    return accepted;
  }

  private onAmbilightUpdate(style: AmbilightCached | null, fallback: boolean): void {
    this.ambilightService.updateFromPoll(style, fallback);

    // Update ambilight state sensor
    const ambilightOn = style
      ? style.styleName !== 'OFF'
      : fallback;
    this.stateSensorService.update('ambilight', ambilightOn);
  }

  private onMuteChange(muted: boolean): void {
    if (muted !== this.isMuted) {
      this.isMuted = muted;
      this.speakerService.updateCharacteristic(this.Characteristic.Mute, muted);
      this.stateSensorService.update('mute', muted);
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
