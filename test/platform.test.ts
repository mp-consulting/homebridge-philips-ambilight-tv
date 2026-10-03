import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ============================================================================
// MOCKS
// ============================================================================

const mocks = vi.hoisted(() => ({
  accessoryCtor: vi.fn(),
  cleanup: vi.fn(),
  resolve: vi.fn((mac: string) => `uuid-${mac}`),
}));

vi.mock('../src/platformAccessory.js', () => ({
  PhilipsAmbilightTVAccessory: class {
    cleanup = mocks.cleanup;
    constructor(_platform: unknown, accessory: unknown) {
      mocks.accessoryCtor(accessory);
    }
  },
}));

vi.mock('../src/services/AccessoryIdentityStore.js', () => ({
  AccessoryIdentityStore: class {
    resolve = mocks.resolve;
  },
}));

import { PhilipsAmbilightTVPlatform } from '../src/platform.js';
import registerPlugin, { isSupportedNodeVersion } from '../src/index.js';

// ============================================================================
// HELPERS
// ============================================================================

const VALID = {
  name: 'Living Room',
  ip: '192.168.1.50',
  mac: 'AA:BB:CC:DD:EE:FF',
  username: 'user',
  password: 'pass',
};

function createApi() {
  const api = Object.assign(new EventEmitter(), {
    hap: {
      Service: {},
      Characteristic: {},
      Categories: { TELEVISION: 31 },
      uuid: { generate: (s: string) => `uuid(${s})` },
    },
    user: { storagePath: () => '/storage', persistPath: () => '/storage/persist' },
    platformAccessory: class {
      context: Record<string, unknown> = {};
      constructor(public displayName: string, public UUID: string) {}
    },
    publishExternalAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn(),
    registerPlatform: vi.fn(),
  });
  return api;
}

function createLog() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function launch(devices: unknown[]) {
  const api = createApi();
  const log = createLog();
  new PhilipsAmbilightTVPlatform(log as never, { platform: 'PhilipsAmbilightTV', devices } as never, api as never);
  api.emit('didFinishLaunching');
  return { api, log };
}

// ============================================================================
// TESTS
// ============================================================================

describe('PhilipsAmbilightTVPlatform', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('publishes each valid TV as an external accessory under its resolved identity', () => {
    const { api } = launch([VALID]);

    expect(mocks.resolve).toHaveBeenCalledWith('AA:BB:CC:DD:EE:FF');
    expect(api.publishExternalAccessories).toHaveBeenCalledTimes(1);
    const [, [accessory]] = api.publishExternalAccessories.mock.calls[0];
    expect(accessory).toMatchObject({ displayName: 'Living Room', UUID: 'uuid-AA:BB:CC:DD:EE:FF' });
  });

  it('warns when no devices are configured', () => {
    const { log, api } = launch([]);
    expect(log.warn).toHaveBeenCalledWith('No devices configured');
    expect(api.publishExternalAccessories).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing password', { ...VALID, password: undefined }],
    ['an out-of-range IP', { ...VALID, ip: '300.1.1.1' }],
    ['a host name instead of an IP', { ...VALID, ip: 'tv.local' }],
    ['a malformed MAC', { ...VALID, mac: 'AA:BB:CC' }],
    ['a non-object entry', 'not-a-device'],
  ])('skips a device with %s', (_label, device) => {
    const { api, log } = launch([device]);
    expect(api.publishExternalAccessories).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });

  it('skips a second device with the same MAC, however it is spelled', () => {
    const { api, log } = launch([VALID, { ...VALID, name: 'Copy', mac: 'aa-bb-cc-dd-ee-ff' }]);
    expect(api.publishExternalAccessories).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('already used by another configured TV'));
  });

  it('drops an out-of-range polling interval rather than the device', () => {
    const device = { ...VALID, pollingInterval: 50 };
    const { api, log } = launch([device]);
    expect(api.publishExternalAccessories).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('out of range'));
    expect(device).not.toHaveProperty('pollingInterval');
  });

  it('sanitizes the display name for HomeKit', () => {
    const { api } = launch([{ ...VALID, name: 'TV #1 (Salon)' }]);
    const [, [accessory]] = api.publishExternalAccessories.mock.calls[0];
    expect(accessory.displayName).toBe('TV 1 Salon');
  });

  it('cleans every accessory up on shutdown', () => {
    const { api } = launch([VALID, { ...VALID, mac: '11:22:33:44:55:66' }]);
    api.emit('shutdown');
    expect(mocks.cleanup).toHaveBeenCalledTimes(2);
  });

  it('unregisters stale cached accessories once launching finishes', () => {
    const api = createApi();
    const platform = new PhilipsAmbilightTVPlatform(createLog() as never, { platform: 'PhilipsAmbilightTV' } as never, api as never);
    const stale = { displayName: 'Old' };
    platform.configureAccessory(stale as never);
    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled();

    api.emit('didFinishLaunching');
    expect(api.unregisterPlatformAccessories).toHaveBeenCalledWith(expect.any(String), 'PhilipsAmbilightTV', [stale]);
  });
});

describe('plugin registration', () => {
  it.each([
    ['v22.10.0', true],
    ['v22.9.0', false],
    ['v24.0.0', true],
    ['v26.3.1', true],
    ['v20.18.0', false],
    ['v23.1.0', false],
    ['garbage', false],
  ])('treats Node %s as supported: %s', (version, expected) => {
    expect(isSupportedNodeVersion(version)).toBe(expected);
  });

  it('registers the platform', () => {
    const api = createApi();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerPlugin(api as never);
    expect(api.registerPlatform).toHaveBeenCalledWith('PhilipsAmbilightTV', PhilipsAmbilightTVPlatform);
    // The running test Node is a supported line, so no warning.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
