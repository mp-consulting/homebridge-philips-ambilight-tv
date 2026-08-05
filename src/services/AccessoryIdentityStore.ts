/**
 * Stable HomeKit identity for the TV accessories this plugin publishes.
 *
 * A TV is published as an *external* accessory, and Homebridge derives such an
 * accessory's HAP username — the identity a controller pairs against — from the
 * accessory UUID and nothing else (`bridgeService.ts`:
 * `advertiseAddress = generate(hapAccessory.UUID)`). This plugin derives that
 * UUID from the configured MAC, so the *spelling* of the MAC in config.json,
 * not merely its value, decides which accessory HomeKit sees: `AA:BB:CC:DD:EE:FF`,
 * `aa:bb:cc:dd:ee:ff` and `aa-bb-cc-dd-ee-ff` name the same TV, all pass config
 * validation, and each produces a different — unpaired — accessory.
 *
 * Re-running the pairing wizard was enough to trigger that, because "Get MAC"
 * reads the address from the OS ARP table (lowercase) while an address typed
 * off the TV's network screen is usually uppercase. The old accessory stays
 * paired on the controller but is no longer advertised, so the TV goes
 * unresponsive in the Home app and drops out of the iOS Remote.
 *
 * This store looks for the pairing a controller actually holds — including one
 * left behind under a different spelling, which is what puts a TV that has
 * already drifted back where HomeKit expects it, without the user re-adding it
 * and losing its room, scenes and automations. Having found one it records that
 * identity and keeps to it, so a later change of spelling is inert.
 *
 * It deliberately records nothing until a pairing exists to anchor the choice.
 * A TV that has not been added to HomeKit yet has no identity worth preserving,
 * and one whose pairing cannot be found is a TV whose owner may still be fixing
 * this by hand — restoring the address as it used to be written. Freezing a
 * guess would pin the TV to it and silently make that no longer work.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { macHexDigits, normalizeMacAddress } from '../api/utils.js';
import { PLATFORM_NAME } from '../settings.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Single file for every configured TV, keyed by the MAC's hex digits. */
const IDENTITY_FILE = 'philips-tv-accessory-identity.json';

// ============================================================================
// TYPES
// ============================================================================

export interface AccessoryIdentityDeps {
  /** Homebridge storage path — where this plugin's own caches live. */
  readonly storagePath: string;
  /** Homebridge persist path — where HAP keeps its AccessoryInfo records. */
  readonly persistPath: string;
  /** `api.hap.uuid.generate`. */
  readonly generateUuid: (data: string) => string;
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

/** The frozen identity of one TV. The seed is kept for diagnostics: it records
 *  which spelling of the MAC the UUID was derived from. */
interface IdentityRecord {
  readonly seed: string;
  readonly uuid: string;
}

// ============================================================================
// HELPERS
// ============================================================================

/** The string fed to `uuid.generate` — unchanged from the original scheme, so
 *  an identity already in use resolves to exactly the same UUID as before. */
const uuidSeed = (mac: string): string => `${PLATFORM_NAME}-${mac}`;

/**
 * The spellings of `mac` that could have been used to derive an identity, the
 * configured one first so it always wins when more than one is paired.
 *
 * These are the ones anything actually produces: the settings UI writes the
 * canonical form, the OS ARP table prints lowercase, and an address typed off
 * the TV is all upper or all lower. The config also admits mixed case and mixed
 * separators, which are not enumerated here — there are too many to probe, and
 * a TV paired under one is recovered by putting that spelling back in
 * config.json, which works because nothing is recorded until a pairing is found.
 */
const macSpellings = (mac: string): string[] => {
  const hex = macHexDigits(mac);
  if (!hex) {
    return [mac];
  }
  const pairs = hex.match(/.{2}/g)!;
  const colon = pairs.join(':');
  const dash = pairs.join('-');
  return [...new Set([mac, colon, colon.toUpperCase(), dash, dash.toUpperCase()])];
};

/**
 * The HAP username Homebridge would advertise an accessory under.
 *
 * This mirrors `homebridge/dist/util/mac.js`, which is internal and not exposed
 * to plugins. Reimplementing it is only ever used to *look for* an existing
 * pairing, so if Homebridge ever changes the derivation the lookup simply finds
 * nothing and the configured spelling is used — the same result as not looking
 * at all.
 */
const hapUsername = (uuid: string): string => {
  const digest = crypto.createHash('sha1').update(uuid).digest('hex');
  let i = 0;
  return 'xx:xx:xx:xx:xx:xx'.replace(/x/g, () => digest[i++]).toUpperCase();
};

// ============================================================================
// ACCESSORY IDENTITY STORE
// ============================================================================

export class AccessoryIdentityStore {
  private records: Record<string, IdentityRecord> = {};
  private readonly filePath: string;

  constructor(private readonly deps: AccessoryIdentityDeps) {
    this.filePath = path.join(deps.storagePath, IDENTITY_FILE);
    this.load();
  }

  // ==========================================================================
  // RESOLUTION
  // ==========================================================================

  /**
   * The accessory UUID to publish this TV under: the identity recorded for it
   * if there is one, else whichever spelling of the MAC a controller is already
   * paired with, else the configured spelling.
   */
  resolve(mac: string): string {
    const key = macHexDigits(mac) ?? mac;

    const known = this.records[key];
    if (known) {
      if (known.seed !== uuidSeed(mac)) {
        this.deps.log('debug', `Keeping the HomeKit identity recorded for ${normalizeMacAddress(mac)} (${known.seed})`);
      }
      return known.uuid;
    }

    const spellings = macSpellings(mac);
    const paired = spellings.find(spelling => this.isPaired(this.deps.generateUuid(uuidSeed(spelling))));

    // Nothing paired to anchor a decision to — a TV not yet added to HomeKit,
    // or one whose pairing was cleared, or one paired under a spelling this
    // does not enumerate (an unusual mixed case, say). Follow config.json and
    // record nothing: freezing a guess would pin the TV to it and quietly turn
    // the standing fix for this — putting the address back as it was written —
    // into a no-op.
    if (!paired) {
      this.deps.log('debug', `No existing HomeKit pairing found for ${normalizeMacAddress(mac)}; using the configured MAC`);
      return this.deps.generateUuid(uuidSeed(mac));
    }

    if (paired !== spellings[0]) {
      this.deps.log(
        'info',
        `Found this TV already paired in HomeKit under MAC "${paired}" rather than the configured "${mac}". ` +
        'Publishing it under the paired identity so it stays the same accessory — no need to re-add it in the Home app.',
      );
    }

    const seed = uuidSeed(paired);
    const uuid = this.deps.generateUuid(seed);
    this.records[key] = { seed, uuid };
    this.save();
    return uuid;
  }

  /** True when HAP holds a record for this accessory with at least one paired
   *  controller. A record on its own is not enough: one is written as soon as an
   *  accessory is published, including the unpaired one a drifted identity
   *  leaves behind. */
  private isPaired(uuid: string): boolean {
    const username = hapUsername(uuid).replace(/:/g, '');
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(this.deps.persistPath, `AccessoryInfo.${username}.json`), 'utf-8'));
      return Object.keys(saved?.pairedClients ?? {}).length > 0;
    } catch {
      // No record, or one we cannot read — treat as unpaired.
      return false;
    }
  }

  // ==========================================================================
  // PERSISTENCE
  // ==========================================================================

  private load(): void {
    try {
      this.records = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
    } catch {
      // No file yet — normal on first run.
      this.records = {};
    }
  }

  /** Written synchronously: the identity has to survive a crash between here
   *  and the accessory being published, or the next run could decide differently. */
  private save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.records, null, 2), 'utf-8');
    } catch {
      this.deps.log('warn', 'Failed to persist the accessory identity to disk');
    }
  }
}
