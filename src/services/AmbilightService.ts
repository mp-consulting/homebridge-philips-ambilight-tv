import type { AdaptiveLightingController, Characteristic, CharacteristicValue, ColorUtils, HapStatusError, PlatformAccessory, Service } from 'homebridge';

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

/** A colour pick in the Home app writes Hue, Saturation (and often Brightness)
 *  as separate characteristics within a few milliseconds. Waiting this long
 *  lets them land as one FOLLOW_COLOR command instead of up to three. */
const COLOR_COALESCE_MS = 50;

/** The TV's menu brightness scale (0-10) that HomeKit's 0-100 maps onto when
 *  Ambilight is following video or audio rather than showing a colour. */
const MENU_BRIGHTNESS_MAX = 10;

// ============================================================================
// TYPES
// ============================================================================

export interface AmbilightServiceDeps {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly AdaptiveLightingController: typeof AdaptiveLightingController;
  readonly ColorUtils: typeof ColorUtils;
  readonly tvClient: PhilipsTVClient;
  readonly accessory: PlatformAccessory;
  readonly ambilightMode?: string;
  /** Whether the TV is currently believed to be powered on. */
  readonly isPoweredOn: () => boolean;
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
  /** The TV's current Ambilight style as last seen or set (e.g. FOLLOW_VIDEO). */
  private currentStyle: string | null = null;
  private adaptiveLighting?: AdaptiveLightingController;
  /** The coalesced colour write waiting to be sent, shared by every handler
   *  that changed a component of the colour in the meantime. */
  private pendingColorWrite: Promise<void> | null = null;
  private colorWriteTimer?: ReturnType<typeof setTimeout>;

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
    this.adaptiveLighting = new this.deps.AdaptiveLightingController(this.service);
    accessory.configureController(this.adaptiveLighting);

    tvService.addLinkedService(this.service);

    return this.service;
  }

  // ==========================================================================
  // HANDLERS
  // ==========================================================================

  /**
   * Turn Ambilight on using the configured mode. Used to auto-start Ambilight
   * when the TV powers on (the `ambilightOnStart` option).
   */
  async startWithConfiguredMode(): Promise<void> {
    const { style, algorithm } = this.parseAmbilightMode();
    this.deps.log('info', `Auto-starting Ambilight (${style}${algorithm ? '/' + algorithm : ''})`);

    try {
      const powerOn = await this.deps.tvClient.setAmbilightPower(true);
      if (!powerOn) {
        this.deps.log('warn', 'Failed to auto-start Ambilight: power on rejected');
        return;
      }
      const success = await this.deps.tvClient.setAmbilightStyle(style as AmbilightStyleName, algorithm || undefined);
      if (success) {
        this.isOn = true;
        this.currentStyle = style;
        this.service.updateCharacteristic(this.deps.Characteristic.On, true);
      }
      // TV restores its own default mode async after power ON; re-apply in background
      this.scheduleStyleRetry(style as AmbilightStyleName, algorithm || undefined);
    } catch {
      this.deps.log('warn', 'Failed to auto-start Ambilight on TV power-on');
    }
  }

  /**
   * Reflect the TV powering off: Ambilight is off, so update the HomeKit
   * Lightbulb to Off without sending a command to the (now unreachable) TV.
   */
  reflectPowerOff(): void {
    this.cancelStyleRetry();
    this.cancelColorWrite();
    if (this.isOn) {
      this.isOn = false;
      this.service.updateCharacteristic(this.deps.Characteristic.On, false);
      this.deps.log('debug', 'Ambilight set to OFF (TV powered off)');
    }
  }

  private parseAmbilightMode(): { style: string; algorithm: string } {
    const mode = this.deps.ambilightMode || DEFAULT_AMBILIGHT_MODE;
    const [style, algorithm = ''] = mode.split('/');
    return { style: style.toUpperCase(), algorithm: algorithm.toUpperCase() };
  }

  private async handleSetOn(value: CharacteristicValue): Promise<void> {
    const shouldBeOn = value as boolean;
    this.deps.log('info', `Setting Ambilight to ${shouldBeOn ? 'ON' : 'OFF'}`);

    this.lastUserAction = Date.now();

    // Switching Ambilight off on a TV that is already off is already true —
    // sending it costs a round-trip that can only time out.
    if (!shouldBeOn && !this.deps.isPoweredOn()) {
      this.cancelStyleRetry();
      this.isOn = false;
      this.deps.log('debug', 'Ambilight already off (TV powered off)');
      return;
    }

    try {
      let success: boolean;
      if (shouldBeOn) {
        const { style, algorithm } = this.parseAmbilightMode();
        const powerOn = await this.deps.tvClient.setAmbilightPower(true);
        if (!powerOn) {
          throw this.deps.communicationError();
        }
        success = await this.deps.tvClient.setAmbilightStyle(style as AmbilightStyleName, algorithm || undefined);
        if (success) {
          this.isOn = true;
          this.currentStyle = style;
          this.lastUserAction = Date.now();
        }
        // TV restores its own default mode async after power ON; re-apply in background
        this.scheduleStyleRetry(style as AmbilightStyleName, algorithm || undefined);
      } else {
        this.cancelStyleRetry();
        this.cancelColorWrite();
        success = await this.deps.tvClient.setAmbilightOff();
        if (success) {
          this.currentStyle = 'OFF';
        }
      }

      if (success) {
        this.isOn = shouldBeOn;
        this.lastUserAction = Date.now();
      } else {
        throw this.deps.communicationError();
      }
    } catch (error) {
      // A scene that turns the TV and Ambilight off together races: the TV can
      // reach standby while this command is still queued behind the power-off,
      // and it then fails against an unreachable TV. Ambilight is off either
      // way, so reporting a communication failure would only paint the
      // accessory "No Response" for something that did happen.
      if (!shouldBeOn && !this.deps.isPoweredOn()) {
        this.isOn = false;
        this.deps.log('debug', 'Ambilight command dropped — TV reached standby first (Ambilight is off)');
        return;
      }
      this.deps.log('warn', 'Failed to change Ambilight state');
      throw error instanceof Error && 'hapStatus' in error ? error : this.deps.communicationError();
    }
  }

  private async handleSetBrightness(value: CharacteristicValue): Promise<void> {
    const newBrightness = value as number;
    this.deps.log('debug', `Setting Ambilight brightness to ${newBrightness}%`);
    this.brightness = newBrightness;

    if (!this.isOn) {
      return;
    }

    // Following video or audio there is no colour to dim: switching to a
    // static colour just to change brightness would throw away the mode the
    // user chose. The TV's own brightness setting is the faithful mapping.
    if (!this.isShowingColor()) {
      const level = Math.round((newBrightness / HOMEKIT_BRIGHTNESS_MAX) * MENU_BRIGHTNESS_MAX);
      const ok = await this.deps.tvClient.setAmbilightBrightness(level);
      if (!ok) {
        this.deps.log('warn', 'Failed to update Ambilight brightness');
        throw this.deps.communicationError();
      }
      this.lastUserAction = Date.now();
      return;
    }

    await this.writeColor('brightness');
  }

  private async handleSetHue(value: CharacteristicValue): Promise<void> {
    this.hue = value as number;
    this.deps.log('debug', `Setting Ambilight hue to ${this.hue}`);
    if (this.isOn) {
      await this.writeColor('hue');
    }
  }

  private async handleSetSaturation(value: CharacteristicValue): Promise<void> {
    this.saturation = value as number;
    this.deps.log('debug', `Setting Ambilight saturation to ${this.saturation}%`);
    if (this.isOn) {
      await this.writeColor('saturation');
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

    if (!this.isOn) {
      return;
    }

    // Adaptive Lighting re-sends the temperature every few minutes on its
    // own. Letting that flip a TV following video into a static colour would
    // silently undo the user's mode; only a colour the user picked follows it.
    if (this.adaptiveLighting?.isAdaptiveLightingActive() && !this.isShowingColor()) {
      this.deps.log('debug', 'Adaptive Lighting update ignored — Ambilight is not in a colour mode');
      return;
    }

    await this.writeColor('color temperature');
  }

  /** True when Ambilight shows a fixed colour, so colour/brightness writes apply. */
  private isShowingColor(): boolean {
    return this.currentStyle === 'FOLLOW_COLOR';
  }

  /**
   * Send the current hue/saturation/brightness as one FOLLOW_COLOR command,
   * coalescing the burst of writes a single colour pick produces. Every
   * caller in the burst awaits the same command, so each handler still
   * reports a failure to HomeKit.
   */
  private writeColor(component: string): Promise<void> {
    if (!this.pendingColorWrite) {
      this.pendingColorWrite = new Promise<void>((resolve, reject) => {
        this.colorWriteTimer = setTimeout(async () => {
          this.pendingColorWrite = null;
          this.colorWriteTimer = undefined;
          const color = this.homekitToPhilipsColor(this.hue, this.saturation, this.brightness);
          const ok = await this.deps.tvClient.setAmbilightFollowColor(color);
          if (ok) {
            this.currentStyle = 'FOLLOW_COLOR';
            this.lastUserAction = Date.now();
            resolve();
          } else {
            reject(this.deps.communicationError());
          }
        }, COLOR_COALESCE_MS);
      });
    }
    return this.pendingColorWrite.catch((error: unknown) => {
      this.deps.log('warn', `Failed to update Ambilight ${component}`);
      throw error;
    });
  }

  private cancelColorWrite(): void {
    if (this.colorWriteTimer) {
      clearTimeout(this.colorWriteTimer);
      this.colorWriteTimer = undefined;
    }
    this.pendingColorWrite = null;
  }

  /** Stop every pending timer (Homebridge shutdown). */
  cleanup(): void {
    this.cancelStyleRetry();
    this.cancelColorWrite();
  }

  /**
   * TV restores its own default ambilight mode asynchronously after power ON.
   * Re-send the desired style after delays to override it.
   */
  private cancelStyleRetry(): void {
    if (this.styleRetryTimer) {
      clearTimeout(this.styleRetryTimer);
      this.styleRetryTimer = undefined;
    }
  }

  private scheduleStyleRetry(style: AmbilightStyleName, algorithm?: string): void {
    this.cancelStyleRetry();

    const delays = [3000, 6000];
    let attempt = 0;

    const retry = (): void => {
      if (attempt >= delays.length || !this.isOn) {
        return;
      }

      this.styleRetryTimer = setTimeout(async () => {
        if (!this.isOn) {
          return;
        }
        try {
          const current = await this.deps.tvClient.getAmbilightStyle();
          if (current?.styleName) {
            this.currentStyle = current.styleName.toUpperCase();
          }
          if (current?.styleName?.toUpperCase() !== style.toUpperCase()) {
            this.deps.log('debug', `Ambilight style drift detected (${current?.styleName}), re-applying ${style}`);
            if (await this.deps.tvClient.setAmbilightStyle(style, algorithm)) {
              this.currentStyle = style.toUpperCase();
            }
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
      this.currentStyle = ambilightStyle.styleName?.toUpperCase() ?? null;
      const ambilightOn = this.currentStyle !== 'OFF';

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
