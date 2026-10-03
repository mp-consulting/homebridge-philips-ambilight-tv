import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// MOCKS
// ============================================================================

vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn().mockImplementation(() => {
      throw new Error('ENOENT');
    }),
  },
}));

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

import fs from 'fs';
import { rename, writeFile } from 'fs/promises';
import { HOME_URI, WATCH_TV_URI } from '../../../src/api/PhilipsTVClient.js';
import { InputCatalog, dedupeById, reportedPackages } from '../../../src/services/inputs/InputCatalog.js';
import { InputConfigStore, validateInputConfigs } from '../../../src/services/inputs/InputConfigStore.js';
import { buildDisplayOrderTLV } from '../../../src/services/inputs/InputServiceFactory.js';
import { STATIC_SOURCE_COUNT, isSystemForegroundPackage } from '../../../src/services/inputs/constants.js';

const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockWriteFile = vi.mocked(writeFile);
const mockRename = vi.mocked(rename);

// ============================================================================
// INPUT CATALOG
// ============================================================================

describe('InputCatalog', () => {
  const app = (packageName: string, label = packageName) => ({ label, intent: { component: { packageName } } });

  it('collapses an app listed once per launcher activity and sorts by name', () => {
    const catalog = new InputCatalog({ sourceConfigs: new Map() });
    const inputs = catalog.appsFromTV([app('com.b', 'Bravo'), app('com.a', 'Alpha'), app('com.b', 'Bravo Kids')] as never);
    expect(inputs.map(i => i.id)).toEqual(['com.a', 'com.b']);
  });

  it('drops system packages unless the user marked them visible', () => {
    const hidden = new InputCatalog({ sourceConfigs: new Map() });
    expect(hidden.appsFromTV([app('com.android.vending')] as never)).toEqual([]);

    const shown = new InputCatalog({ sourceConfigs: new Map([['com.android.vending', { id: 'com.android.vending', visible: true }]]) });
    expect(shown.appsFromTV([app('com.android.vending')] as never)).toHaveLength(1);
  });

  it('starts with the static sources, then cached, custom and visible apps — once each', () => {
    const catalog = new InputCatalog({
      customApps: [{ name: 'Custom', packageName: 'com.custom', className: 'com.custom.Main' }],
      sourceConfigs: new Map([
        ['com.visible', { id: 'com.visible', visible: true }],
        [WATCH_TV_URI, { id: WATCH_TV_URI, visible: true }],
      ]),
    });
    const inputs = catalog.startupInputs([
      { id: 'com.custom', name: 'Cached', configuredName: '', type: 'app', identifier: 9, visibility: 0 },
      { id: 'com.cached', name: 'Cached', configuredName: '', type: 'app', identifier: 10, visibility: 0 },
    ]);
    const ids = inputs.map(i => i.id);
    expect(ids.slice(0, STATIC_SOURCE_COUNT)).toContain(HOME_URI);
    expect(ids.filter(id => id === WATCH_TV_URI)).toHaveLength(1);
    expect(ids).toEqual(expect.arrayContaining(['com.custom', 'com.cached', 'com.visible']));
    // The custom app's explicit launch intent wins over the cached entry.
    expect(inputs.find(i => i.id === 'com.custom')?.className).toBe('com.custom.Main');
  });

  it('knows which apps the user asked for', () => {
    const catalog = new InputCatalog({
      customApps: [{ name: 'C', packageName: 'com.c' }],
      sourceConfigs: new Map([['com.v', { id: 'com.v', visible: true }], ['com.h', { id: 'com.h', visible: false }]]),
    });
    expect(catalog.isUserRequested('com.c')).toBe(true);
    expect(catalog.isUserRequested('com.v')).toBe(true);
    expect(catalog.isUserRequested('com.h')).toBe(false);
  });

  it('dedupeById keeps the first occurrence', () => {
    expect(dedupeById([{ id: 'a', n: 1 }, { id: 'a', n: 2 }, { id: 'b', n: 3 }])).toEqual([{ id: 'a', n: 1 }, { id: 'b', n: 3 }]);
  });

  it('reportedPackages includes excluded system packages', () => {
    expect(reportedPackages([app('org.droidtv.playtv'), app('com.x'), {}] as never)).toEqual(new Set(['org.droidtv.playtv', 'com.x']));
  });
});

// ============================================================================
// INPUT CONFIG STORE
// ============================================================================

describe('validateInputConfigs', () => {
  it('keeps well-formed entries, first per id and per identifier', () => {
    const valid = validateInputConfigs([
      { id: 'a', name: 'A', configuredName: 'Mine\n', type: 'app', identifier: 7, visibility: 0 },
      { id: 'a', name: 'Dup id', type: 'app', identifier: 8 },
      { id: 'b', name: 'Dup identifier', type: 'app', identifier: 7 },
      { id: 'c', name: 'Bad type', type: 'widget', identifier: 9 },
      { id: 'd', name: 'Bad identifier', type: 'app', identifier: 1.5 },
      'junk',
    ]);
    expect(valid).toEqual([{ id: 'a', name: 'A', configuredName: 'Mine', type: 'app', identifier: 7, visibility: 0 }]);
  });

  it('returns nothing for a non-array', () => {
    expect(validateInputConfigs({ id: 'a' })).toEqual([]);
    expect(validateInputConfigs(null)).toEqual([]);
  });
});

describe('InputConfigStore', () => {
  let context: Record<string, unknown>;
  let log: ReturnType<typeof vi.fn>;
  const createStore = () => new InputConfigStore({
    accessory: { context } as never,
    storagePath: '/storage',
    deviceId: 'AA:BB:CC:DD:EE:FF',
    log,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    context = {};
    log = vi.fn();
    mockWriteFile.mockClear();
    mockRename.mockClear();
    mockReadFileSync.mockReset().mockImplementation(() => {
      throw new Error('ENOENT');
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allocates identifiers above the static range, skipping ones in use', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify([
      { id: 'cached', name: 'C', type: 'app', identifier: STATIC_SOURCE_COUNT + 1, visibility: 0 },
    ]));
    const store = createStore();
    store.load();

    expect(store.resolveIdentifier('cached', [])).toBe(STATIC_SOURCE_COUNT + 1);
    expect(store.resolveIdentifier('new', [STATIC_SOURCE_COUNT + 2])).toBe(STATIC_SOURCE_COUNT + 3);
  });

  it('debounces saves into one atomic write', async () => {
    const store = createStore();
    store.load();
    const config = { id: 'a', name: 'A', configuredName: 'A', type: 'app' as const, identifier: 7, visibility: 0 };

    store.save([config]);
    store.save([{ ...config, name: 'B' }]);
    expect(context.inputConfigs).toEqual([{ ...config, name: 'B' }]);
    expect(mockWriteFile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const [tempPath, json] = mockWriteFile.mock.calls[0];
    expect(JSON.parse(json as string)[0].name).toBe('B');
    expect(mockRename).toHaveBeenCalledWith(tempPath, '/storage/philips-tv-inputs-aabbccddeeff.json');
  });

  it('flush writes immediately and is a no-op with nothing pending', async () => {
    const store = createStore();
    store.load();
    await store.flush();
    expect(mockWriteFile).not.toHaveBeenCalled();

    store.save([]);
    await store.flush();
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });

  it('prefers configs already in the accessory context', () => {
    context.inputConfigs = [{ id: 'ctx', name: 'Ctx', type: 'app', identifier: 12, visibility: 0 }];
    const store = createStore();
    store.load();
    expect(store.get('ctx')?.identifier).toBe(12);
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });
});

// ============================================================================
// DISPLAY ORDER
// ============================================================================

describe('buildDisplayOrderTLV', () => {
  const decode = (tlv: Buffer): number[] => {
    const ids: number[] = [];
    for (let i = 0; i < tlv.length;) {
      if (tlv[i] === 0x01) {
        ids.push(tlv.readUInt32LE(i + 2));
        i += 6;
      } else {
        i += 2;
      }
    }
    return ids;
  };

  it('puts ordered inputs first, then the rest in registration order', () => {
    const inputs = [
      { id: 'a', identifier: 7 },
      { id: 'b', identifier: 8 },
      { id: 'c', identifier: 9 },
      { id: 'd', identifier: 10 },
    ];
    const order: Record<string, number> = { c: 0, a: 1 };
    const tlv = buildDisplayOrderTLV(inputs, id => order[id]);

    expect(decode(tlv)).toEqual([9, 7, 8, 10]);
    // Element separators between entries, none trailing.
    expect(tlv.subarray(6, 8)).toEqual(Buffer.from([0x00, 0x00]));
    expect(tlv.length).toBe(4 * 6 + 3 * 2);
  });

  it('encodes an empty list as an empty buffer', () => {
    expect(buildDisplayOrderTLV([], () => undefined).length).toBe(0);
  });
});

describe('isSystemForegroundPackage', () => {
  it.each([
    ['org.droidtv.playtv', true],
    ['org.droidtv.channels', true],
    ['com.google.android.apps.tv.launcherx', true],
    ['com.vendor.customlauncher', true],
    ['com.netflix.ninja', false],
  ])('%s → %s', (pkg, expected) => {
    expect(isSystemForegroundPackage(pkg)).toBe(expected);
  });
});
