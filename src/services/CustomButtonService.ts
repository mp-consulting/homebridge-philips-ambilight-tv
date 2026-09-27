import type { Characteristic, CharacteristicValue, HapStatusError, PlatformAccessory, Service } from 'homebridge';

import type { PhilipsTVClient } from '../api/PhilipsTVClient.js';
import { REMOTE_KEYS } from '../api/types.js';
import type { CustomButtonConfig, RemoteKey } from '../api/types.js';
import { sanitizeForHomeKit } from '../api/utils.js';

// ============================================================================
// TYPES
// ============================================================================

export interface CustomButtonDeps {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly tvClient: PhilipsTVClient;
  readonly communicationError: () => HapStatusError;
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const SUBTYPE_PREFIX = 'custom-button-';

/** How long the switch shows ON after a press, so the tap registers visibly in the Home app. */
export const BUTTON_RESET_DELAY_MS = 1000;

const VALID_KEYS: ReadonlySet<string> = new Set(REMOTE_KEYS);

// ============================================================================
// CUSTOM BUTTON SERVICE
// ============================================================================

/**
 * Exposes user-configured remote keys as momentary Switch services: turning
 * one on sends its key once, then the switch turns itself back off.
 *
 * The subtype is derived from the key rather than the name, so renaming a
 * button keeps its HomeKit identity (and any scenes using it). That makes
 * each key usable once per TV — two switches sending the same key would be
 * indistinguishable anyway.
 */
export class CustomButtonService {
  private readonly resetTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: CustomButtonDeps) {}

  // ==========================================================================
  // CONFIGURATION
  // ==========================================================================

  configureButtons(accessory: PlatformAccessory, buttons: CustomButtonConfig[], tvName: string): void {
    const { Service: Svc, Characteristic: Char } = this.deps;
    const valid = this.validate(buttons);

    // Remove switches for buttons that are no longer configured
    const validSubtypes = new Set(valid.map(b => `${SUBTYPE_PREFIX}${b.key}`));
    accessory.services
      .filter(s => s.UUID === Svc.Switch.UUID && s.subtype?.startsWith(SUBTYPE_PREFIX))
      .forEach(s => {
        if (!validSubtypes.has(s.subtype!)) {
          accessory.removeService(s);
        }
      });

    for (const button of valid) {
      const subtype = `${SUBTYPE_PREFIX}${button.key}`;
      const label = sanitizeForHomeKit(button.name || button.key);
      const displayName = `${tvName} ${label}`;

      let service = accessory.getServiceById(Svc.Switch, subtype);
      if (!service) {
        service = accessory.addService(Svc.Switch, displayName, subtype);
        service.addOptionalCharacteristic(Char.ConfiguredName);
      }

      service.setCharacteristic(Char.Name, displayName);
      service.setCharacteristic(Char.ConfiguredName, label);
      service.setCharacteristic(Char.On, false);

      const target = service;
      service.getCharacteristic(Char.On)
        .onGet(() => false)
        .onSet((value) => this.handleSet(target, button.key, value));
    }

    if (valid.length > 0) {
      this.deps.log('info', `Configured ${valid.length} custom button(s): ${valid.map(b => b.key).join(', ')}`);
    }
  }

  /** Drop entries with an unknown key or a key already used by an earlier button. */
  private validate(buttons: CustomButtonConfig[]): CustomButtonConfig[] {
    const seen = new Set<string>();
    const valid: CustomButtonConfig[] = [];
    for (const button of buttons) {
      if (!button || !VALID_KEYS.has(button.key)) {
        this.deps.log('warn', `Custom button "${button?.name ?? ''}": unknown key "${button?.key}". Skipping.`);
        continue;
      }
      if (seen.has(button.key)) {
        this.deps.log('warn', `Custom button "${button.name}": key "${button.key}" is already used by another button. Skipping.`);
        continue;
      }
      seen.add(button.key);
      valid.push(button);
    }
    return valid;
  }

  // ==========================================================================
  // HANDLERS
  // ==========================================================================

  private async handleSet(service: Service, key: RemoteKey, value: CharacteristicValue): Promise<void> {
    if (!value) {
      return;
    }

    this.deps.log('info', `Custom button: sending ${key}`);
    this.scheduleReset(service, key);

    try {
      const success = await this.deps.tvClient.sendKey(key);
      if (!success) {
        throw this.deps.communicationError();
      }
    } catch (error) {
      this.deps.log('warn', `Custom button: failed to send ${key}`);
      throw error instanceof Error && 'hapStatus' in error ? error : this.deps.communicationError();
    }
  }

  private scheduleReset(service: Service, key: RemoteKey): void {
    const existing = this.resetTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.resetTimers.set(key, setTimeout(() => {
      this.resetTimers.delete(key);
      service.updateCharacteristic(this.deps.Characteristic.On, false);
    }, BUTTON_RESET_DELAY_MS));
  }

  cleanup(): void {
    for (const timer of this.resetTimers.values()) {
      clearTimeout(timer);
    }
    this.resetTimers.clear();
  }
}
