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
 * This store makes the identity decision once per TV and remembers it, so a
 * later change of spelling is inert. For a TV whose identity has already
 * drifted it first looks for the pairing left behind under another spelling and
 * keeps using that one, which puts the accessory back where the controller
 * expects it without the user re-adding the TV and losing its room, scenes and
 * automations.
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
 * Every spelling of `mac` that could have been used to derive an identity, the
 * configured one first so it always wins when more than one is paired.
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
   * The accessory UUID to publish this TV under. Decided on first sight and
   * kept from then on, whatever the MAC's spelling in config.json later becomes.
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

    const seed = this.chooseSeed(mac);
    const uuid = this.deps.generateUuid(seed);
    this.records[key] = { seed, uuid };
    this.save();
    return uuid;
  }

  /**
   * Pick the spelling to derive this TV's identity from: whichever one a
   * controller is already paired with, else the configured one. Preferring an
   * existing pairing is what recovers a TV whose MAC was re-detected in a
   * different case and which therefore disappeared from HomeKit.
   */
  private chooseSeed(mac: string): string {
    const spellings = macSpellings(mac);
    const paired = spellings.find(spelling => this.isPaired(this.deps.generateUuid(uuidSeed(spelling))));

    if (paired && paired !== spellings[0]) {
      this.deps.log(
        'info',
        `Found this TV already paired in HomeKit under MAC "${paired}" rather than the configured "${mac}". ` +
        'Publishing it under the paired identity so it stays the same accessory — no need to re-add it in the Home app.',
      );
      return uuidSeed(paired);
    }

    return uuidSeed(spellings[0]);
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
