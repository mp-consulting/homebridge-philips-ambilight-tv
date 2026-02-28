import type { AdaptiveLightingController, CharacteristicValue, ColorUtils, HapStatusError, PlatformAccessory, Service } from 'homebridge';

import type { PhilipsTVClient } from '../api/PhilipsTVClient.js';
import type { AmbilightCached, AmbilightColor, AmbilightStyleName } from '../api/types.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** HomeKit color ranges */
const HOMEKIT_HUE_MAX = 360;
const HOMEKIT_SATURATION_MAX = 100;
const HOMEKIT_BRIGHTNESS_MAX = 100;

/** Philips Ambilight color ranges */
const PHILIPS_COLOR_MAX = 255;

/** Color temperature range in mireds */
const COLOR_TEMP_MIN = 140;  // ≈7100K cool daylight
const COLOR_TEMP_MAX = 500;  // ≈2000K warm candlelight
const COLOR_TEMP_DEFAULT = 280; // ≈3570K neutral

/** Default ambilight mode when turning on */
const DEFAULT_AMBILIGHT_MODE = 'FOLLOW_VIDEO/NATURAL';

/** Ignore poll updates for this long after a user action (ms) */
const USER_ACTION_COOLDOWN_MS = 10_000;

// ============================================================================
// TYPES
// ============================================================================

export interface AmbilightServiceDeps {
  readonly Service: typeof Service;
  readonly Characteristic: typeof import('homebridge').Characteristic;
  readonly AdaptiveLightingController: typeof AdaptiveLightingController;
  readonly ColorUtils: typeof ColorUtils;
  readonly tvClient: PhilipsTVClient;
  readonly accessory: PlatformAccessory;
  readonly ambilightMode?: string;
  readonly communicationError: () => HapStatusError;
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

// ============================================================================
// AMBILIGHT SERVICE
// ============================================================================

export class AmbilightService {
  private service!: Service;

  private isOn = false;
  private brightness = 100; // 0-100 for HomeKit
  private hue = 0;          // 0-360 for HomeKit
  private saturation = 0;   // 0-100 for HomeKit
  private colorTemperature = COLOR_TEMP_DEFAULT; // mireds
  private lastUserAction = 0; // Timestamp of last user-initiated change
  private styleRetryTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly deps: AmbilightServiceDeps) {}

  // ==========================================================================
  // ACCESSORS
  // ==========================================================================

  get isAmbilightOn(): boolean {
    return this.isOn;
  }

  getService(): Service {
    return this.service;
  }

  // ==========================================================================
  // CONFIGURATION
  // ==========================================================================

  configureService(accessory: PlatformAccessory, tvService: Service): Service {
    const { Service: Svc, Characteristic: Char } = this.deps;

    this.service = accessory.getService(Svc.Lightbulb)
      ?? accessory.addService(Svc.Lightbulb, 'Ambilight', 'ambilight');

    this.service.setCharacteristic(Char.Name, 'Ambilight');

    this.service.getCharacteristic(Char.On)
      .onGet(() => this.isOn)
      .onSet((value) => this.handleSetOn(value));

    this.service.getCharacteristic(Char.Brightness)
      .onGet(() => this.brightness)
      .onSet((value) => this.handleSetBrightness(value));

    this.service.getCharacteristic(Char.Hue)
      .onGet(() => this.hue)
      .onSet((value) => this.handleSetHue(value));

    this.service.getCharacteristic(Char.Saturation)
      .onGet(() => this.saturation)
      .onSet((value) => this.handleSetSaturation(value));

    this.service.getCharacteristic(Char.ColorTemperature)
      .setProps({ minValue: COLOR_TEMP_MIN, maxValue: COLOR_TEMP_MAX })
      .onGet(() => this.colorTemperature)
      .onSet((value) => this.handleSetColorTemperature(value));

    // Enable Adaptive Lighting (automatic mode — controller manages transitions)
    const adaptiveLightingController = new this.deps.AdaptiveLightingController(this.service);
    accessory.configureController(adaptiveLightingController);

    tvService.addLinkedService(this.service);

    return this.service;
  }

  // ==========================================================================
  // HANDLERS
  // ==========================================================================

  private parseAmbilightMode(): { style: string; algorithm: string } {
    const mode = this.deps.ambilightMode || DEFAULT_AMBILIGHT_MODE;
    const [style, algorithm = ''] = mode.split('/');
    return { style: style.toUpperCase(), algorithm: algorithm.toUpperCase() };
  }

  private async handleSetOn(value: CharacteristicValue): Promise<void> {
    const shouldBeOn = value as boolean;
    this.deps.log('info', `Setting Ambilight to ${shouldBeOn ? 'ON' : 'OFF'}`);

    this.lastUserAction = Date.now();

    try {
      let success: boolean;
      if (shouldBeOn) {
        const { style, algorithm } = this.parseAmbilightMode();
        await this.deps.tvClient.setAmbilightPower(true);
        success = await this.deps.tvClient.setAmbilightStyle(style as AmbilightStyleName, algorithm || undefined);
        if (success) {
          this.isOn = true;
          this.lastUserAction = Date.now();
        }
        // TV restores its own default mode async after power ON; re-apply in background
        this.scheduleStyleRetry(style as AmbilightStyleName, algorithm || undefined);
      } else {
        success = await this.deps.tvClient.setAmbilightOff();
      }

      if (success) {
        this.isOn = shouldBeOn;
        this.lastUserAction = Date.now();
      } else {
        throw this.deps.communicationError();
      }
    } catch (error) {
      this.deps.log('warn', 'Failed to change Ambilight state');
      throw error instanceof Error && 'hapStatus' in error ? error : this.deps.communicationError();
    }
  }

  private async handleSetBrightness(value: CharacteristicValue): Promise<void> {
    const newBrightness = value as number;
    this.deps.log('debug', `Setting Ambilight brightness to ${newBrightness}%`);
    this.brightness = newBrightness;

    if (this.isOn) {
      try {
        const color = this.homekitToPhilipsColor(this.hue, this.saturation, newBrightness);
        await this.deps.tvClient.setAmbilightFollowColor(color);
        this.lastUserAction = Date.now();
      } catch {
        this.deps.log('warn', 'Failed to update Ambilight brightness');
      }
    }
  }

  private async handleSetHue(value: CharacteristicValue): Promise<void> {
    const newHue = value as number;
    this.deps.log('debug', `Setting Ambilight hue to ${newHue}`);
    this.hue = newHue;

    if (this.isOn) {
      try {
        const color = this.homekitToPhilipsColor(newHue, this.saturation, this.brightness);
        await this.deps.tvClient.setAmbilightFollowColor(color);
        this.lastUserAction = Date.now();
      } catch {
        this.deps.log('warn', 'Failed to update Ambilight hue');
      }
    }
  }

  private async handleSetSaturation(value: CharacteristicValue): Promise<void> {
    const newSaturation = value as number;
    this.deps.log('debug', `Setting Ambilight saturation to ${newSaturation}%`);
    this.saturation = newSaturation;

    if (this.isOn) {
      try {
        const color = this.homekitToPhilipsColor(this.hue, newSaturation, this.brightness);
        await this.deps.tvClient.setAmbilightFollowColor(color);
        this.lastUserAction = Date.now();
      } catch {
        this.deps.log('warn', 'Failed to update Ambilight saturation');
      }
    }
  }

  private async handleSetColorTemperature(value: CharacteristicValue): Promise<void> {
    const newTemp = value as number;
    this.deps.log('debug', `Setting Ambilight color temperature to ${newTemp} mireds`);
    this.colorTemperature = newTemp;

    // Convert mireds to HomeKit hue/saturation using HAP-NodeJS utility
    const { hue, saturation } = this.deps.ColorUtils.colorTemperatureToHueAndSaturation(newTemp);
    this.hue = hue;
    this.saturation = saturation;

    // Sync Hue/Saturation characteristics without disabling Adaptive Lighting
    const { Characteristic: Char } = this.deps;
    this.service.getCharacteristic(Char.Hue).updateValue(hue);
    this.service.getCharacteristic(Char.Saturation).updateValue(saturation);

    if (this.isOn) {
      try {
        const color = this.homekitToPhilipsColor(hue, saturation, this.brightness);
        await this.deps.tvClient.setAmbilightFollowColor(color);
        this.lastUserAction = Date.now();
      } catch {
        this.deps.log('warn', 'Failed to update Ambilight color temperature');
      }
    }
  }

  /**
   * TV restores its own default ambilight mode asynchronously after power ON.
   * Re-send the desired style after delays to override it.
   */
  private scheduleStyleRetry(style: AmbilightStyleName, algorithm?: string): void {
    if (this.styleRetryTimer) {
      clearTimeout(this.styleRetryTimer);
    }

    const delays = [3000, 6000];
    let attempt = 0;

    const retry = (): void => {
      if (attempt >= delays.length || !this.isOn) {
        return;
      }

      this.styleRetryTimer = setTimeout(async () => {
        try {
          const current = await this.deps.tvClient.getAmbilightStyle();
          if (current?.styleName?.toUpperCase() !== style.toUpperCase()) {
            this.deps.log('debug', `Ambilight style drift detected (${current?.styleName}), re-applying ${style}`);
            await this.deps.tvClient.setAmbilightStyle(style, algorithm);
            this.lastUserAction = Date.now();
          }
        } catch {
          this.deps.log('debug', 'Failed to re-apply ambilight style');
        }
        attempt++;
        retry();
      }, delays[attempt]);
    };

    retry();
  }

  // ==========================================================================
  // POLLING UPDATE
  // ==========================================================================

  updateFromPoll(ambilightStyle: AmbilightCached | null, ambilightPowerFallback: boolean): void {
    const { Characteristic: Char } = this.deps;

    // Skip poll updates during cooldown after user action to prevent race conditions
    if (Date.now() - this.lastUserAction < USER_ACTION_COOLDOWN_MS) {
      return;
    }

    if (ambilightStyle) {
      const ambilightOn = ambilightStyle.styleName?.toUpperCase() !== 'OFF';

      if (ambilightOn !== this.isOn) {
        this.isOn = ambilightOn;
        this.service.updateCharacteristic(Char.On, ambilightOn);
        this.deps.log('debug', `Ambilight state updated: ${ambilightOn ? 'ON' : 'OFF'}`);
      }

      if (ambilightStyle.styleName?.toUpperCase() === 'FOLLOW_COLOR' && ambilightStyle.colorSettings?.color) {
        const homeKitColor = this.philipsToHomekitColor(ambilightStyle.colorSettings.color);

        if (homeKitColor.hue !== this.hue) {
          this.hue = homeKitColor.hue;
          this.service.updateCharacteristic(Char.Hue, homeKitColor.hue);
        }
        if (homeKitColor.saturation !== this.saturation) {
          this.saturation = homeKitColor.saturation;
          this.service.updateCharacteristic(Char.Saturation, homeKitColor.saturation);
        }
        if (homeKitColor.brightness !== this.brightness) {
          this.brightness = homeKitColor.brightness;
          this.service.updateCharacteristic(Char.Brightness, homeKitColor.brightness);
        }
      }
    } else {
      if (ambilightPowerFallback !== this.isOn) {
        this.isOn = ambilightPowerFallback;
        this.service.updateCharacteristic(Char.On, ambilightPowerFallback);
        this.deps.log('debug', `Ambilight state updated: ${ambilightPowerFallback ? 'ON' : 'OFF'}`);
      }
    }
  }

  // ==========================================================================
  // COLOR CONVERSION
  // ==========================================================================

  /**
   * Convert HomeKit HSB values to Philips Ambilight color format
   * HomeKit: Hue 0-360, Saturation 0-100, Brightness 0-100
   * Philips: Hue 0-255, Saturation 0-255, Brightness 0-255
   */
  homekitToPhilipsColor(hue: number, saturation: number, brightness: number): AmbilightColor {
    return {
      hue: Math.min(PHILIPS_COLOR_MAX, Math.round((hue / HOMEKIT_HUE_MAX) * PHILIPS_COLOR_MAX)),
      saturation: Math.min(PHILIPS_COLOR_MAX, Math.round((saturation / HOMEKIT_SATURATION_MAX) * PHILIPS_COLOR_MAX)),
      brightness: Math.min(PHILIPS_COLOR_MAX, Math.round((brightness / HOMEKIT_BRIGHTNESS_MAX) * PHILIPS_COLOR_MAX)),
    };
  }

  /**
   * Convert Philips Ambilight color format to HomeKit HSB values
   * Philips: Hue 0-255, Saturation 0-255, Brightness 0-255
   * HomeKit: Hue 0-360, Saturation 0-100, Brightness 0-100
   */
  philipsToHomekitColor(color: AmbilightColor): { hue: number; saturation: number; brightness: number } {
    return {
      hue: Math.min(HOMEKIT_HUE_MAX, Math.round((color.hue / PHILIPS_COLOR_MAX) * HOMEKIT_HUE_MAX)),
      saturation: Math.min(HOMEKIT_SATURATION_MAX, Math.round((color.saturation / PHILIPS_COLOR_MAX) * HOMEKIT_SATURATION_MAX)),
      brightness: Math.min(HOMEKIT_BRIGHTNESS_MAX, Math.round((color.brightness / PHILIPS_COLOR_MAX) * HOMEKIT_BRIGHTNESS_MAX)),
    };
  }
}
