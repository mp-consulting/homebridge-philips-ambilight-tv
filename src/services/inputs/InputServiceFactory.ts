import type { Characteristic, PlatformAccessory, Service } from 'homebridge';

import type { SourceConfig } from '../../api/types.js';
import { cleanControllerName, sanitizeForHomeKit, sanitizeForLog } from '../../api/utils.js';
import { GENERIC_INPUT_NAME_RE, TLV_ELEMENT_END, TLV_ELEMENT_START } from './constants.js';
import type { InputData, InputSource, InputSourceConfig, LogFn } from './types.js';

// ============================================================================
// DISPLAY ORDER
// ============================================================================

/**
 * Encode input identifiers as the TLV8 DisplayOrder value. Inputs with an
 * order (`orderOf`) come first, sorted by it; the rest keep their relative
 * order after them.
 */
export function buildDisplayOrderTLV(
  inputs: readonly Pick<InputSource, 'id' | 'identifier'>[],
  orderOf: (id: string) => number | undefined,
): Buffer {
  const sorted = [...inputs].sort((a, b) => {
    const orderA = orderOf(a.id);
    const orderB = orderOf(b.id);
    if (orderA !== undefined && orderB !== undefined) {
      return orderA - orderB;
    }
    if (orderA !== undefined) {
      return -1;
    }
    if (orderB !== undefined) {
      return 1;
    }
    return 0;
  });

  const parts: Buffer[] = [];
  sorted.forEach((input, i) => {
    if (i > 0) {
      parts.push(Buffer.from([TLV_ELEMENT_END, 0x00]));
    }
    const idBuf = Buffer.alloc(4);
    idBuf.writeUInt32LE(input.identifier, 0);
    parts.push(Buffer.from([TLV_ELEMENT_START, 0x04, ...idBuf]));
  });
  return Buffer.concat(parts);
}

// ============================================================================
// INPUT SERVICE FACTORY
// ============================================================================

export interface InputServiceFactoryDeps {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly accessory: PlatformAccessory;
  /** Sources config (Homebridge UI) indexed by id. */
  readonly sourceConfigs: ReadonlyMap<string, SourceConfig>;
  readonly log: LogFn;
  /** Called after the user renames or shows/hides an input in HomeKit. */
  readonly onConfigChanged: () => void;
}

/**
 * Builds and maintains the HomeKit InputSource services that back the
 * inputs: creating or restoring each one under its stable subtype, applying
 * the configured name and visibility, and wiring the rename / visibility
 * handlers.
 */
export class InputServiceFactory {
  constructor(private readonly deps: InputServiceFactoryDeps) {}

  /** The service for `input`, reusing the one already under its identifier. */
  restoreOrCreate(input: InputData, identifier: number, cached: InputSourceConfig | undefined, tvService: Service): InputSource {
    const { Characteristic: Char } = this.deps;
    const subtype = `input-${identifier}`;
    const defaultName = sanitizeForHomeKit(input.name);
    const inputSourceType = input.type === 'source' ? Char.InputSourceType.HDMI : Char.InputSourceType.APPLICATION;

    const visibility = this.resolveVisibility(input.id, cached);
    const displayName = this.resolveDisplayName(input.id, cached, defaultName);

    let service = this.deps.accessory.getServiceById(this.deps.Service.InputSource, subtype);
    if (service) {
      service
        .setCharacteristic(Char.ConfiguredName, displayName)
        .setCharacteristic(Char.CurrentVisibilityState, visibility)
        .setCharacteristic(Char.TargetVisibilityState, visibility)
        .setCharacteristic(Char.InputSourceType, inputSourceType);
    } else {
      service = this.deps.accessory.addService(this.deps.Service.InputSource, displayName, subtype);
      service
        .setCharacteristic(Char.ConfiguredName, displayName)
        .setCharacteristic(Char.InputSourceType, inputSourceType)
        .setCharacteristic(Char.IsConfigured, Char.IsConfigured.CONFIGURED)
        .setCharacteristic(Char.Name, displayName)
        .setCharacteristic(Char.CurrentVisibilityState, visibility)
        .setCharacteristic(Char.TargetVisibilityState, visibility)
        .setCharacteristic(Char.Identifier, identifier);
      tvService.addLinkedService(service);
    }

    this.bindHandlers(service, defaultName);

    return {
      id: input.id,
      name: defaultName,
      type: input.type,
      identifier,
      service,
      className: input.className,
      action: input.action,
    };
  }

  /** Wire (or re-wire, after a rename) the ConfiguredName and visibility handlers. */
  bindHandlers(service: Service, originalName: string): void {
    const { Characteristic: Char } = this.deps;
    let validName = (service.getCharacteristic(Char.ConfiguredName).value as string) || originalName;

    service.getCharacteristic(Char.ConfiguredName)
      .onGet(() => validName)
      .onSet((value) => {
        const newName = cleanControllerName(String(value ?? ''));

        // Workaround for tvOS 18 HomeHub bug (https://github.com/homebridge/homebridge/issues/3703):
        // the controller writes its own generic, locale-dependent placeholder
        // (e.g. "Input Source 2", "Entrada 2") back into ConfiguredName. Ignore
        // it so it never clobbers the real app label.
        if (!newName || GENERIC_INPUT_NAME_RE.test(newName)) {
          return;
        }

        validName = newName;
        this.deps.log('debug', `Input renamed to: ${sanitizeForLog(newName)}`);
        this.deps.onConfigChanged();
      });

    service.getCharacteristic(Char.TargetVisibilityState)
      .onSet((value) => {
        service.setCharacteristic(Char.CurrentVisibilityState, value as number);
        this.deps.log('debug', `Input visibility changed: ${value === Char.CurrentVisibilityState.SHOWN ? 'shown' : 'hidden'}`);
        this.deps.onConfigChanged();
      });
  }

  /** The record to persist for `input`. */
  toConfig(input: InputSource): InputSourceConfig {
    const { Characteristic: Char } = this.deps;
    return {
      id: input.id,
      name: input.name,
      configuredName: cleanControllerName(String(input.service.getCharacteristic(Char.ConfiguredName).value ?? '')),
      type: input.type,
      identifier: input.identifier,
      visibility: input.service.getCharacteristic(Char.CurrentVisibilityState).value as number,
    };
  }

  /** Remove services recorded for inputs that are no longer wanted. */
  removeStale(keepIds: ReadonlySet<string>, cachedConfigs: readonly InputSourceConfig[]): void {
    const { Service: Svc } = this.deps;
    const bySubtype = new Map(cachedConfigs.map(c => [`input-${c.identifier}`, c]));

    for (const service of [...this.deps.accessory.services]) {
      if (service.UUID !== Svc.InputSource.UUID) {
        continue;
      }
      const config = service.subtype ? bySubtype.get(service.subtype) : undefined;
      if (config && !keepIds.has(config.id)) {
        this.deps.accessory.removeService(service);
      }
    }
  }

  /** Remove one input's service. */
  remove(input: InputSource): void {
    this.deps.accessory.removeService(input.service);
  }

  /**
   * Visibility: sources config (Homebridge UI) → cached HomeKit state → shown.
   */
  private resolveVisibility(inputId: string, cached: InputSourceConfig | undefined): number {
    const { Characteristic: Char } = this.deps;
    const sourceConfig = this.deps.sourceConfigs.get(inputId);
    if (sourceConfig?.visible !== undefined) {
      return sourceConfig.visible ? Char.CurrentVisibilityState.SHOWN : Char.CurrentVisibilityState.HIDDEN;
    }
    return cached ? cached.visibility : Char.CurrentVisibilityState.SHOWN;
  }

  /**
   * Display name: sources config customName → cached ConfiguredName → default.
   */
  private resolveDisplayName(inputId: string, cached: InputSourceConfig | undefined, defaultName: string): string {
    const customName = this.deps.sourceConfigs.get(inputId)?.customName;
    if (customName) {
      return sanitizeForHomeKit(customName);
    }
    return cached?.configuredName || defaultName;
  }
}
