import type { Characteristic, CharacteristicValue, HapStatusError, PlatformAccessory, Service } from 'homebridge';
import fs from 'fs';
import { writeFile } from 'fs/promises';
import path from 'path';

import type { PhilipsTVClient } from '../api/PhilipsTVClient.js';
import { HOME_URI, WATCH_TV_URI } from '../api/PhilipsTVClient.js';
import { sanitizeForHomeKit } from '../api/utils.js';

// ============================================================================
// TYPES
// ============================================================================

export interface SourceSwitchDeps {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly tvClient: PhilipsTVClient;
  /** Homebridge storage path for persisting user switch renames. */
  readonly storagePath: string;
  /** Device id (MAC) used to key the persisted rename file. */
  readonly deviceId: string;
  readonly communicationError: () => HapStatusError;
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  readonly onSourceSwitch?: (sourceId: string) => void;
}

/** A registered source switch with its associated HomeKit service */
interface SourceSwitch {
  readonly id: string;
  readonly name: string;
  readonly type: 'app' | 'source' | 'channel';
  readonly service: Service;
  readonly channelListId?: string;
  readonly className?: string;
  readonly action?: string;
}

// ============================================================================
// SOURCE SWITCH SERVICE
// ============================================================================

/**
 * Exposes input sources as individual Switch services in HomeKit.
 * This allows sources to be used in HomeKit automations and scenes,
 * which is not possible with the standard Television InputSource services.
 *
 * Only one switch is ON at a time (the currently active source).
 * Turning a switch ON launches that source on the TV.
 */
export class SourceSwitchService {
  private switches: SourceSwitch[] = [];
  private activeSourceId: string | null = null;

  /** User-set switch names, keyed by source id. Persisted to disk because the
   *  TV accessory is external and its context is not saved across restarts. */
  private customNames: Record<string, string> = {};
  private readonly namesCachePath: string;

  constructor(private readonly deps: SourceSwitchDeps) {
    const safeId = deps.deviceId.replace(/[:-]/g, '').toLowerCase();
    this.namesCachePath = path.join(deps.storagePath, `philips-tv-switch-names-${safeId}.json`);
    this.loadCustomNames();
  }

  private loadCustomNames(): void {
    try {
      this.customNames = JSON.parse(fs.readFileSync(this.namesCachePath, 'utf-8'));
    } catch {
      // No file yet — normal on first run.
      this.customNames = {};
    }
  }

  private saveCustomNames(): void {
    writeFile(this.namesCachePath, JSON.stringify(this.customNames), 'utf-8')
      .catch(() => this.deps.log('warn', 'Failed to persist source switch names to disk'));
  }

  // ==========================================================================
  // CONFIGURATION
  // ==========================================================================

  configureSwitches(
    accessory: PlatformAccessory,
    sources: ReadonlyArray<{ id: string; name: string; type: 'app' | 'source' | 'channel'; channelListId?: string; className?: string; action?: string }>,
    tvName: string,
  ): void {
    const { Service: Svc, Characteristic: Char } = this.deps;

    // Rebuild the internal registry from scratch — this method is re-run when the
    // input list changes (e.g. apps discovered after the TV wakes), so the array
    // must not accumulate duplicates. Existing services are reused below.
    this.switches = [];

    // Remove stale switch services that are no longer in the source list
    const validSubtypes = new Set(sources.map(s => `source-switch-${s.id}`));
    accessory.services
      .filter(s => s.UUID === Svc.Switch.UUID && s.subtype?.startsWith('source-switch-'))
      .forEach(s => {
        if (!validSubtypes.has(s.subtype!)) {
          accessory.removeService(s);
        }
      });

    for (const source of sources) {
      const subtype = `source-switch-${source.id}`;
      const displayName = `${tvName} ${source.name}`;

      let service = accessory.getServiceById(Svc.Switch, subtype);
      const isNew = !service;
      if (!service) {
        service = accessory.addService(Svc.Switch, displayName, subtype);
        service.addOptionalCharacteristic(Char.ConfiguredName);
        // Seed the base Name once, on creation. Reasserting it on every restart
        // can make the Home app drop a rename the user made on the tile.
        service.setCharacteristic(Char.Name, displayName);
      }

      this.applyConfiguredName(service, source.id, source.name, isNew);

      service.getCharacteristic(Char.ConfiguredName)
        .onSet((value) => this.handleRenameSwitch(source.id, value));

      service.getCharacteristic(Char.On)
        .onGet(() => this.handleGetSwitch(source.id))
        .onSet((value) => this.handleSetSwitch(source.id, value));

      this.switches.push({
        id: source.id,
        name: source.name,
        type: source.type,
        service,
        channelListId: source.channelListId,
        className: source.className,
        action: source.action,
      });
    }

    if (sources.length > 0) {
      this.deps.log('info', `Configured ${sources.length} source switch(es)`);
    }
  }

  // ==========================================================================
  // HANDLERS
  // ==========================================================================

  /**
   * Decide what to write to a switch's ConfiguredName, without clobbering a
   * rename the user made in the Home app.
   *
   * The Home app frequently keeps a switch rename *client-side* and never writes
   * it back to ConfiguredName, so we can't capture it. Re-asserting our default
   * name on every restart (the old behaviour) then reset the user's rename. So:
   *  - a rename we *did* capture (customNames) always wins and is restored;
   *  - a brand-new switch is seeded with the source's default/label;
   *  - an existing switch is left untouched, except to upgrade a leftover
   *    package-id placeholder (e.g. "com netflix ninja") to the real label once
   *    the TV reports it.
   */
  private applyConfiguredName(service: Service, sourceId: string, sourceName: string, isNew: boolean): void {
    const { Characteristic: Char } = this.deps;

    const stored = this.customNames[sourceId];
    if (stored) {
      service.setCharacteristic(Char.ConfiguredName, stored);
      return;
    }

    if (isNew) {
      service.setCharacteristic(Char.ConfiguredName, sourceName);
      return;
    }

    // Existing switch, no captured rename: only replace a package-id placeholder
    // with the friendly label; otherwise leave whatever name is there so a
    // Home-app rename survives the restart.
    const current = service.getCharacteristic(Char.ConfiguredName).value;
    const placeholder = sanitizeForHomeKit(sourceId);
    if (current === placeholder && sourceName !== placeholder) {
      service.setCharacteristic(Char.ConfiguredName, sourceName);
    }
  }

  /** Persist a switch name the user changed in HomeKit so it survives restarts. */
  private handleRenameSwitch(sourceId: string, value: CharacteristicValue): void {
    const newName = (typeof value === 'string' ? value : '').trim();
    if (!newName) {
      return;
    }
    if (this.customNames[sourceId] === newName) {
      return;
    }
    this.customNames[sourceId] = newName;
    this.saveCustomNames();
    this.deps.log('debug', `Source switch renamed: ${sourceId} → ${newName}`);
  }

  private handleGetSwitch(sourceId: string): CharacteristicValue {
    return this.activeSourceId === sourceId;
  }

  private async handleSetSwitch(sourceId: string, value: CharacteristicValue): Promise<void> {
    const on = value as boolean;

    if (!on) {
      // HomeKit toggling off — we don't turn off the TV, just ignore
      // but keep the switch state consistent with the active source
      if (this.activeSourceId === sourceId) {
        // Re-set it to ON since the source is still active
        const sw = this.switches.find(s => s.id === sourceId);
        if (sw) {
          setTimeout(() => {
            sw.service.updateCharacteristic(this.deps.Characteristic.On, true);
          }, 100);
        }
      }
      return;
    }

    const sw = this.switches.find(s => s.id === sourceId);
    if (!sw) {
      return;
    }

    this.deps.log('info', `Source switch: ${sw.name}`);

    try {
      const success = await this.launchSource(sw);
      if (success) {
        this.setActiveSource(sourceId);
        this.deps.onSourceSwitch?.(sourceId);
      } else {
        throw this.deps.communicationError();
      }
    } catch (error) {
      this.deps.log('warn', `Failed to switch source: ${sw.name}`);
      throw error instanceof Error && 'hapStatus' in error ? error : this.deps.communicationError();
    }
  }

  // ==========================================================================
  // STATE UPDATES
  // ==========================================================================

  /**
   * Update switch states from poll data (current active app/source).
   * Called by the accessory when the active input changes.
   *
   * Only updates if the polled source matches a known switch.
   * The TV may report system package names (e.g. org.droidtv.playtv) that
   * don't match the URI-based IDs used by Watch TV / Home sources — in that
   * case we keep the current state so switches don't bounce off.
   */
  updateFromPoll(currentSourceId: string | null): void {
    if (currentSourceId === this.activeSourceId) {
      return;
    }
    // Only update if the source matches a registered switch
    if (currentSourceId !== null && !this.switches.some(s => s.id === currentSourceId)) {
      return;
    }
    this.setActiveSource(currentSourceId);
  }

  /** Turn off all switches (e.g., when TV powers off) */
  resetAll(): void {
    this.activeSourceId = null;
    for (const sw of this.switches) {
      sw.service.updateCharacteristic(this.deps.Characteristic.On, false);
    }
  }

  // ==========================================================================
  // PRIVATE
  // ==========================================================================

  private setActiveSource(sourceId: string | null): void {
    const previous = this.activeSourceId;
    this.activeSourceId = sourceId;

    for (const sw of this.switches) {
      const isActive = sw.id === sourceId;
      const wasActive = sw.id === previous;
      if (isActive !== wasActive) {
        sw.service.updateCharacteristic(this.deps.Characteristic.On, isActive);
      }
    }
  }

  private async launchSource(sw: SourceSwitch): Promise<boolean> {
    switch (sw.type) {
      case 'app':
        return this.deps.tvClient.launchApplication(sw.id, sw.className, sw.action);
      case 'source':
        if (sw.id === WATCH_TV_URI) {
          return this.deps.tvClient.launchWatchTV();
        }
        if (sw.id === HOME_URI) {
          return this.deps.tvClient.launchHome();
        }
        return this.deps.tvClient.setSource(sw.id);
      case 'channel': {
        await this.deps.tvClient.launchWatchTV();
        return this.deps.tvClient.setChannel(parseInt(sw.id, 10), sw.channelListId);
      }
    }
  }
}
