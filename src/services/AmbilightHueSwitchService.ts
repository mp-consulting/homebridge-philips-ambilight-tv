import type { Characteristic, CharacteristicValue, HapStatusError, PlatformAccessory, Service } from 'homebridge';

import type { PhilipsTVClient } from '../api/PhilipsTVClient.js';

// ============================================================================
// TYPES
// ============================================================================

export interface AmbilightHueSwitchDeps {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly tvClient: PhilipsTVClient;
  readonly communicationError: () => HapStatusError;
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const SWITCH_SUBTYPE = 'ambilight-hue-switch';

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
    const displayName = `${tvName} Ambilight + Hue`;

    let service = accessory.getServiceById(Svc.Switch, SWITCH_SUBTYPE);
    if (!service) {
      service = accessory.addService(Svc.Switch, displayName, SWITCH_SUBTYPE);
      service.addOptionalCharacteristic(Char.ConfiguredName);
      service.setCharacteristic(Char.ConfiguredName, 'Ambilight + Hue');
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

    try {
      const success = await this.deps.tvClient.setAmbilightHue(on);
      if (success) {
        this.isOn = on;
      } else {
        throw this.deps.communicationError();
      }
    } catch (error) {
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
