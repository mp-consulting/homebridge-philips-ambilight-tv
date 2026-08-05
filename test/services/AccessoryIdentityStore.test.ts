import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import { AccessoryIdentityStore } from '../../src/services/AccessoryIdentityStore.js';
import type { AccessoryIdentityDeps } from '../../src/services/AccessoryIdentityStore.js';

// ============================================================================
// MOCKS
// ============================================================================

vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

import fs from 'fs';

const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);

const STORAGE_PATH = '/storage';
const PERSIST_PATH = '/storage/persist';
const IDENTITY_PATH = '/storage/philips-tv-accessory-identity.json';

/** Stand-in for `api.hap.uuid.generate` — only has to be deterministic and
 *  collision-free, not byte-identical to HAP's. */
const generateUuid = (data: string): string => {
  const s = crypto.createHash('sha1').update(data).digest('hex');
  return [s.slice(0, 8), s.slice(8, 12), s.slice(12, 16), s.slice(16, 20), s.slice(20, 32)].join('-');
};

/** The AccessoryInfo filename HAP would keep a pairing for this UUID under —
 *  mirrors the derivation the store itself has to reproduce. */
const persistFileFor = (mac: string): string => {
  const uuid = generateUuid(`PhilipsAmbilightTV-${mac}`);
  const digest = crypto.createHash('sha1').update(uuid).digest('hex');
  let i = 0;
  const username = 'xxxxxxxxxxxx'.replace(/x/g, () => digest[i++]).toUpperCase();
  return `${PERSIST_PATH}/AccessoryInfo.${username}.json`;
};

let log: ReturnType<typeof vi.fn>;

function createStore(): AccessoryIdentityStore {
  log = vi.fn();
  const deps: AccessoryIdentityDeps = {
    storagePath: STORAGE_PATH,
    persistPath: PERSIST_PATH,
    generateUuid,
    log,
  };
  return new AccessoryIdentityStore(deps);
}

/**
 * Serve the identity file and any AccessoryInfo records from an in-memory map;
 * everything else throws ENOENT the way a missing file does.
 */
function withFiles(files: Record<string, unknown>): void {
  mockReadFileSync.mockImplementation((p: unknown) => {
    const file = files[String(p)];
    if (file === undefined) {
      throw new Error('ENOENT');
    }
    return JSON.stringify(file);
  });
}

/** An AccessoryInfo record for a TV a controller has actually paired with. */
const pairedRecord = { pairedClients: { 'some-controller': 'deadbeef' } };

/** An AccessoryInfo record as written at publish time, before any pairing. */
const unpairedRecord = { pairedClients: {} };

// ============================================================================
// TESTS
// ============================================================================

describe('AccessoryIdentityStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withFiles({});
  });

  describe('identity derivation', () => {
    it('derives the same UUID the plugin used before the store existed', () => {
      const store = createStore();

      expect(store.resolve('AA:BB:CC:DD:EE:FF')).toBe(generateUuid('PhilipsAmbilightTV-AA:BB:CC:DD:EE:FF'));
    });

    it('gives different TVs different identities', () => {
      const store = createStore();

      expect(store.resolve('aa:bb:cc:dd:ee:ff')).not.toBe(store.resolve('11:22:33:44:55:66'));
    });

    it('records the decision so it can be replayed on the next run', () => {
      createStore().resolve('AA:BB:CC:DD:EE:FF');

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        IDENTITY_PATH,
        expect.stringContaining('PhilipsAmbilightTV-AA:BB:CC:DD:EE:FF'),
        'utf-8',
      );
    });

    it('survives an unwritable storage path', () => {
      mockWriteFileSync.mockImplementation(() => {
        throw new Error('EACCES');
      });
      const store = createStore();

      expect(store.resolve('AA:BB:CC:DD:EE:FF')).toBe(generateUuid('PhilipsAmbilightTV-AA:BB:CC:DD:EE:FF'));
      expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('Failed to persist'));
    });
  });

  describe('stability across MAC spellings', () => {
    it('keeps the recorded identity when the configured MAC changes case', () => {
      withFiles({
        [IDENTITY_PATH]: {
          aabbccddeeff: {
            seed: 'PhilipsAmbilightTV-AA:BB:CC:DD:EE:FF',
            uuid: generateUuid('PhilipsAmbilightTV-AA:BB:CC:DD:EE:FF'),
          },
        },
      });

      // The pairing wizard has since rewritten the MAC in lowercase.
      expect(createStore().resolve('aa:bb:cc:dd:ee:ff')).toBe(generateUuid('PhilipsAmbilightTV-AA:BB:CC:DD:EE:FF'));
    });

    it('keeps the recorded identity when the separator changes', () => {
      withFiles({
        [IDENTITY_PATH]: {
          aabbccddeeff: {
            seed: 'PhilipsAmbilightTV-aa:bb:cc:dd:ee:ff',
            uuid: generateUuid('PhilipsAmbilightTV-aa:bb:cc:dd:ee:ff'),
          },
        },
      });

      expect(createStore().resolve('aa-bb-cc-dd-ee-ff')).toBe(generateUuid('PhilipsAmbilightTV-aa:bb:cc:dd:ee:ff'));
    });

    it('does not rewrite a decision it has already recorded', () => {
      withFiles({
        [IDENTITY_PATH]: {
          aabbccddeeff: {
            seed: 'PhilipsAmbilightTV-AA:BB:CC:DD:EE:FF',
            uuid: generateUuid('PhilipsAmbilightTV-AA:BB:CC:DD:EE:FF'),
          },
        },
      });

      createStore().resolve('aa:bb:cc:dd:ee:ff');

      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
  });

  describe('recovering a drifted identity', () => {
    it('reuses the spelling HomeKit is already paired with', () => {
      withFiles({ [persistFileFor('AA:BB:CC:DD:EE:FF')]: pairedRecord });

      // Config now carries the lowercase form the wizard detected.
      expect(createStore().resolve('aa:bb:cc:dd:ee:ff')).toBe(generateUuid('PhilipsAmbilightTV-AA:BB:CC:DD:EE:FF'));
    });

    it('says so in the log, since the config and the published identity differ', () => {
      withFiles({ [persistFileFor('AA:BB:CC:DD:EE:FF')]: pairedRecord });

      createStore().resolve('aa:bb:cc:dd:ee:ff');

      expect(log).toHaveBeenCalledWith('info', expect.stringContaining('AA:BB:CC:DD:EE:FF'));
    });

    it('recovers a dash-separated pairing too', () => {
      withFiles({ [persistFileFor('AA-BB-CC-DD-EE-FF')]: pairedRecord });

      expect(createStore().resolve('aa:bb:cc:dd:ee:ff')).toBe(generateUuid('PhilipsAmbilightTV-AA-BB-CC-DD-EE-FF'));
    });

    it('prefers the configured spelling when that is the paired one', () => {
      withFiles({
        [persistFileFor('aa:bb:cc:dd:ee:ff')]: pairedRecord,
        [persistFileFor('AA:BB:CC:DD:EE:FF')]: pairedRecord,
      });

      const store = createStore();

      expect(store.resolve('aa:bb:cc:dd:ee:ff')).toBe(generateUuid('PhilipsAmbilightTV-aa:bb:cc:dd:ee:ff'));
      expect(log).not.toHaveBeenCalledWith('info', expect.stringContaining('already paired'));
    });

    it('ignores a record left behind by an accessory nobody paired with', () => {
      withFiles({ [persistFileFor('AA:BB:CC:DD:EE:FF')]: unpairedRecord });

      expect(createStore().resolve('aa:bb:cc:dd:ee:ff')).toBe(generateUuid('PhilipsAmbilightTV-aa:bb:cc:dd:ee:ff'));
    });

    it('freezes the recovered identity so it is not re-derived next run', () => {
      withFiles({ [persistFileFor('AA:BB:CC:DD:EE:FF')]: pairedRecord });

      createStore().resolve('aa:bb:cc:dd:ee:ff');

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        IDENTITY_PATH,
        expect.stringContaining('PhilipsAmbilightTV-AA:BB:CC:DD:EE:FF'),
        'utf-8',
      );
    });
  });

  describe('malformed input', () => {
    it('still returns a usable identity for a MAC it cannot parse', () => {
      const store = createStore();

      expect(store.resolve('not-a-mac')).toBe(generateUuid('PhilipsAmbilightTV-not-a-mac'));
    });

    it('starts from scratch when the identity file is corrupt', () => {
      mockReadFileSync.mockImplementation((p: unknown) => {
        if (String(p) === IDENTITY_PATH) {
          return '{ not json';
        }
        throw new Error('ENOENT');
      });

      expect(createStore().resolve('aa:bb:cc:dd:ee:ff')).toBe(generateUuid('PhilipsAmbilightTV-aa:bb:cc:dd:ee:ff'));
    });
  });
});
