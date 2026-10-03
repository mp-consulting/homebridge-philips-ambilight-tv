import type { PlatformAccessory } from 'homebridge';
import fs from 'fs';
import path from 'path';

import { AtomicJsonFile } from '../../api/persist.js';
import { cleanControllerName } from '../../api/utils.js';
import { SAVE_DEBOUNCE_MS, STATIC_SOURCE_COUNT } from './constants.js';
import type { InputSourceConfig, InputType, LogFn } from './types.js';

// ============================================================================
// VALIDATION
// ============================================================================

const INPUT_TYPES: ReadonlySet<string> = new Set<InputType>(['app', 'source', 'channel']);

/**
 * Keep only well-formed entries, the first for each id and each identifier.
 *
 * The cache is ours, but it lives on disk where an older version, a crash or a
 * hand edit can leave anything behind. A non-array used to throw on `.filter`
 * during startup, and a duplicated identifier handed two inputs one HomeKit
 * subtype — and so one service.
 */
export function validateInputConfigs(raw: unknown): InputSourceConfig[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seenIds = new Set<string>();
  const seenIdentifiers = new Set<number>();
  const valid: InputSourceConfig[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (
      typeof e.id !== 'string' || !e.id
      || typeof e.name !== 'string'
      || typeof e.type !== 'string' || !INPUT_TYPES.has(e.type)
      || typeof e.identifier !== 'number' || !Number.isInteger(e.identifier) || e.identifier < 1
      || seenIds.has(e.id) || seenIdentifiers.has(e.identifier)
    ) {
      continue;
    }
    seenIds.add(e.id);
    seenIdentifiers.add(e.identifier);
    valid.push({
      id: e.id,
      name: e.name,
      configuredName: typeof e.configuredName === 'string' ? cleanControllerName(e.configuredName) : '',
      type: e.type as InputType,
      identifier: e.identifier,
      visibility: typeof e.visibility === 'number' ? e.visibility : 0,
    });
  }
  return valid;
}

// ============================================================================
// INPUT CONFIG STORE
// ============================================================================

export interface InputConfigStoreDeps {
  readonly accessory: PlatformAccessory;
  readonly storagePath: string;
  readonly deviceId: string;
  readonly log: LogFn;
}

/**
 * The persisted half of the inputs: each input's HomeKit identifier, name and
 * visibility, which must survive restarts because HomeKit pairs scenes and
 * automations against the identifier.
 *
 * The TV accessory is external, so its context is not saved by Homebridge —
 * the cache file is the record. Saves are coalesced (a pairing or a rename in
 * the Home app writes many characteristics in a burst) and written atomically,
 * since a torn file would reassign every identifier on the next start.
 */
export class InputConfigStore {
  private configs: InputSourceConfig[] = [];
  private byId = new Map<string, InputSourceConfig>();
  private readonly file: AtomicJsonFile;
  private readonly filePath: string;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private pendingWrite: InputSourceConfig[] | null = null;

  constructor(private readonly deps: InputConfigStoreDeps) {
    const safeId = deps.deviceId.replace(/[:-]/g, '').toLowerCase();
    this.filePath = path.join(deps.storagePath, `philips-tv-inputs-${safeId}.json`);
    this.file = new AtomicJsonFile(this.filePath);
  }

  /** Load the cache — from the accessory context when already set, else from disk. */
  load(): void {
    const context = this.deps.accessory.context;
    let raw: unknown = context.inputConfigs;
    if (raw === undefined) {
      try {
        raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        this.deps.log('debug', 'Restored input configs from cache file');
      } catch {
        // No cache file yet (normal on first run), or an unreadable one.
        raw = [];
      }
    }
    this.setConfigs(validateInputConfigs(raw));
  }

  get all(): readonly InputSourceConfig[] {
    return this.configs;
  }

  get(id: string): InputSourceConfig | undefined {
    return this.byId.get(id);
  }

  /**
   * A stable identifier for an input: the one recorded for it, else the
   * lowest free one above the range reserved for static sources that is used
   * by neither a live input nor any recorded one.
   */
  resolveIdentifier(inputId: string, inUse: Iterable<number>): number {
    const cached = this.byId.get(inputId);
    if (cached) {
      return cached.identifier;
    }
    const used = new Set<number>(inUse);
    for (const config of this.configs) {
      used.add(config.identifier);
    }
    let next = STATIC_SOURCE_COUNT + 1;
    while (used.has(next)) {
      next++;
    }
    return next;
  }

  /** Record the current inputs. Visible in memory at once; on disk shortly after. */
  save(configs: InputSourceConfig[]): void {
    this.setConfigs(configs);
    this.pendingWrite = configs;
    if (this.saveTimer) {
      return;
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  /** Write any pending save now (e.g. at shutdown). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    const configs = this.pendingWrite;
    if (!configs) {
      return;
    }
    this.pendingWrite = null;
    try {
      await this.file.write(configs);
    } catch {
      this.deps.log('warn', 'Failed to persist input configs to disk');
    }
  }

  private setConfigs(configs: InputSourceConfig[]): void {
    this.configs = configs;
    this.byId = new Map(configs.map(c => [c.id, c]));
    this.deps.accessory.context.inputConfigs = configs;
  }
}
