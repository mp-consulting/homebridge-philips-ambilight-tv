import type { Characteristic, CharacteristicValue, HapStatusError, PlatformAccessory, Service } from 'homebridge';

import type { PhilipsTVClient } from '../api/PhilipsTVClient.js';

// ============================================================================
// TYPES
// ============================================================================

export interface AmbilightHueSwitchDeps {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly tvClient: PhilipsTVClient;
  /** Whether the TV is currently believed to be powered on. */
  readonly isPoweredOn: () => boolean;
  readonly communicationError: () => HapStatusError;
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const SWITCH_SUBTYPE = 'ambilight-hue-switch';

/**
 * Switch label. HomeKit rejects '+' in a Name characteristic, so the feature
 * Philips brands "Ambilight+hue" is spelled out — matching how
 * `sanitizeForHomeKit` renders '+' in TV-supplied app names (Disney+ → Disney Plus).
 */
const SWITCH_LABEL = 'Ambilight Plus Hue';

/** The pre-1.6.3 label, written to ConfiguredName on installs created before the rename. */
const LEGACY_SWITCH_LABEL = 'Ambilight + Hue';

// ============================================================================
// AMBILIGHT + HUE SWITCH SERVICE
// ============================================================================

/**
 * Exposes the TV's "Ambilight + Hue" integration (Philips Hue lamps following
 * Ambilight) as a dedicated Switch service, so it can be toggled independently
 * of the main Ambilight controls and used in HomeKit automations and scenes.
 *
 * Backed by the JointSpace `/HueLamp/power` endpoint ({"power":"On"|"Off"}).
 */
export class AmbilightHueSwitchService {
  private service: Service | null = null;
  private isOn = false;

  constructor(private readonly deps: AmbilightHueSwitchDeps) {}

  // ==========================================================================
  // CONFIGURATION
  // ==========================================================================

  configureSwitch(accessory: PlatformAccessory, tvName: string): void {
    const { Service: Svc, Characteristic: Char } = this.deps;
    const displayName = `${tvName} ${SWITCH_LABEL}`;

    let service = accessory.getServiceById(Svc.Switch, SWITCH_SUBTYPE);
    if (!service) {
      service = accessory.addService(Svc.Switch, displayName, SWITCH_SUBTYPE);
      service.addOptionalCharacteristic(Char.ConfiguredName);
      service.setCharacteristic(Char.ConfiguredName, SWITCH_LABEL);
    } else if (service.getCharacteristic(Char.ConfiguredName).value === LEGACY_SWITCH_LABEL) {
      // Migrate installs that stored the old label, but only when it is still
      // untouched — a value the user changed in the Home app must not be clobbered.
      service.setCharacteristic(Char.ConfiguredName, SWITCH_LABEL);
    }

    service.setCharacteristic(Char.Name, displayName);

    service.getCharacteristic(Char.On)
      .onGet(() => this.handleGet())
      .onSet((value) => this.handleSet(value));

    this.service = service;
    this.deps.log('info', 'Configured Ambilight + Hue switch');
  }

  /** Remove the switch service if it exists (when the feature is disabled). */
  removeSwitch(accessory: PlatformAccessory): void {
    const service = accessory.getServiceById(this.deps.Service.Switch, SWITCH_SUBTYPE);
    if (service) {
      accessory.removeService(service);
    }
  }

  // ==========================================================================
  // HANDLERS
  // ==========================================================================

  private async handleGet(): Promise<CharacteristicValue> {
    try {
      this.isOn = await this.deps.tvClient.getAmbilightHue();
    } catch {
      // TV unreachable (e.g. powered off) — fall back to last known state
    }
    return this.isOn;
  }

  private async handleSet(value: CharacteristicValue): Promise<void> {
    const on = value as boolean;
    this.deps.log('info', `Ambilight + Hue: ${on ? 'on' : 'off'}`);

    // The integration follows Ambilight, so a TV in standby already has it off
    // — sending the command costs a round-trip that can only time out.
    if (!on && !this.deps.isPoweredOn()) {
      this.isOn = false;
      this.deps.log('debug', 'Ambilight + Hue already off (TV powered off)');
      return;
    }

    try {
      const success = await this.deps.tvClient.setAmbilightHue(on);
      if (success) {
        this.isOn = on;
      } else {
        throw this.deps.communicationError();
      }
    } catch (error) {
      // Turning everything off in one scene races the TV into standby: this
      // command can land after the power-off and fail against an unreachable
      // TV even though the requested state (off) is what the TV now has.
      if (!on && !this.deps.isPoweredOn()) {
        this.isOn = false;
        this.deps.log('debug', 'Ambilight + Hue command dropped — TV reached standby first (already off)');
        return;
      }
      this.deps.log('warn', 'Failed to toggle Ambilight + Hue');
      throw error instanceof Error && 'hapStatus' in error ? error : this.deps.communicationError();
    }
  }

  // ==========================================================================
  // STATE UPDATES
  // ==========================================================================

  /** Force the switch off (e.g. when the TV powers off). */
  reset(): void {
    if (this.isOn) {
      this.isOn = false;
    }
    this.service?.updateCharacteristic(this.deps.Characteristic.On, false);
  }
}
