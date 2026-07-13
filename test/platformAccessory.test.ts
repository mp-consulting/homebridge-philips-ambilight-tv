import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// MOCKS
//
// The accessory constructor wires up every service, so we replace the service
// modules and the TV client with light stubs and only assert the behaviour
// under test: turning the TV off from HomeKit resets the source switches
// immediately, without waiting for the next state poll (issue #14).
// ============================================================================

const mocks = vi.hoisted(() => ({
  resetAll: vi.fn(),
  reflectPowerOff: vi.fn(),
  sensorUpdate: vi.fn(),
  hueReset: vi.fn(),
  getVisibleSources: vi.fn().mockReturnValue([]),
  setPowerState: vi.fn().mockResolvedValue(true),
  getCurrentActivity: vi.fn().mockResolvedValue(null),
  fetchAppsFromTV: vi.fn().mockResolvedValue(undefined),
  inputUpdateFromPoll: vi.fn(),
  switchUpdateFromPoll: vi.fn(),
}));

/** Holder for the poll callbacks the accessory hands to StatePollManager. */
const capture = vi.hoisted(() => ({ pollCallbacks: null as unknown }));

vi.mock('../src/api/PhilipsTVClient.js', () => ({
  PhilipsTVClient: class {
    setPowerState = mocks.setPowerState;
    getCurrentActivity = mocks.getCurrentActivity;
  },
  // Re-exported URI constants used elsewhere; unused here but keep the shape.
  HDMI_SOURCES: {},
  HOME_URI: 'home',
  WATCH_TV_URI: 'watchtv',
}));

vi.mock('../src/services/AmbilightService.js', () => ({
  AmbilightService: class {
    configureService = vi.fn();
    reflectPowerOff = mocks.reflectPowerOff;
    updateFromPoll = vi.fn();
    startWithConfiguredMode = vi.fn();
  },
}));

vi.mock('../src/services/InputSourceManager.js', () => ({
  InputSourceManager: class {
    configureInputSources = vi.fn();
    getVisibleSources = mocks.getVisibleSources;
    handleGetInput = vi.fn();
    handleSetInput = vi.fn();
    handleRemoteKey = vi.fn();
    updateFromPoll = mocks.inputUpdateFromPoll;
    setActiveInputById = vi.fn();
    fetchAppsFromTV = mocks.fetchAppsFromTV;
  },
}));

vi.mock('../src/services/SourceSwitchService.js', () => ({
  SourceSwitchService: class {
    resetAll = mocks.resetAll;
    configureSwitches = vi.fn();
    updateFromPoll = mocks.switchUpdateFromPoll;
  },
}));

vi.mock('../src/services/StateSensorService.js', () => ({
  StateSensorService: class {
    configureSensors = vi.fn();
    update = mocks.sensorUpdate;
  },
}));

vi.mock('../src/services/AmbilightHueSwitchService.js', () => ({
  AmbilightHueSwitchService: class {
    configureSwitch = vi.fn();
    removeSwitch = vi.fn();
    reset = mocks.hueReset;
  },
}));

vi.mock('../src/services/StatePollManager.js', () => ({
  StatePollManager: class {
    start = vi.fn();
    stop = vi.fn();
    cleanup = vi.fn();
    constructor(_client: unknown, _config: unknown, callbacks: unknown) {
      capture.pollCallbacks = callbacks;
    }
  },
}));

import { PhilipsAmbilightTVAccessory } from '../src/platformAccessory.js';

// ============================================================================
// HOMEKIT MOCK HELPERS
// ============================================================================

interface MockCharacteristic {
  onGet: (fn: () => unknown) => MockCharacteristic;
  onSet: (fn: (v: unknown) => void | Promise<void>) => MockCharacteristic;
  _onSet?: (v: unknown) => void | Promise<void>;
}

function createMockService() {
  const chars = new Map<unknown, MockCharacteristic>();
  const service = {
    setCharacteristic: vi.fn().mockReturnThis(),
    updateCharacteristic: vi.fn().mockReturnThis(),
    addLinkedService: vi.fn(),
    getCharacteristic: vi.fn().mockImplementation((key: unknown) => {
      if (!chars.has(key)) {
        const char: MockCharacteristic = {
          onGet: () => char,
          onSet: (fn) => {
            char._onSet = fn;
            return char;
          },
        };
        chars.set(key, char);
      }
      return chars.get(key)!;
    }),
  };
  return service;
}

/** A Characteristic enum-like object — each entry a distinct identity object. */
const Characteristic = {
  Active: { ACTIVE: 1, INACTIVE: 0 },
  ActiveIdentifier: {},
  Name: {},
  ConfiguredName: {},
  SleepDiscoveryMode: { ALWAYS_DISCOVERABLE: 1 },
  CurrentMediaState: { INTERRUPTED: 0 },
  RemoteKey: {},
  VolumeControlType: { ABSOLUTE: 3 },
  VolumeSelector: {},
  Mute: {},
  Manufacturer: {},
  Model: {},
  SerialNumber: {},
};

const Service = {
  Television: { id: 'tv' },
  TelevisionSpeaker: { id: 'speaker' },
  AccessoryInformation: { id: 'info' },
};

function createMocks() {
  const services = new Map<unknown, ReturnType<typeof createMockService>>();
  const accessory = {
    context: {
      device: {
        name: 'Living Room TV',
        mac: 'AA:BB:CC:DD:EE:FF',
        sourceSwitches: false,
        ambilightHueSwitch: false,
      },
    },
    getService: vi.fn().mockImplementation((svc: unknown) => {
      if (!services.has(svc)) {
        services.set(svc, createMockService());
      }
      return services.get(svc)!;
    }),
    addService: vi.fn().mockImplementation((svc: unknown) => {
      if (!services.has(svc)) {
        services.set(svc, createMockService());
      }
      return services.get(svc)!;
    }),
    getServiceById: vi.fn().mockReturnValue(null),
    removeService: vi.fn(),
    services: [] as unknown[],
  };

  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const platform = {
    Service,
    Characteristic,
    log,
    api: {
      hap: {
        AdaptiveLightingController: class {},
        ColorUtils: {},
        HapStatusError: class extends Error {},
        HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
      },
      user: { storagePath: () => '/tmp' },
    },
  };

  return { platform, accessory, services };
}

// ============================================================================
// TEST SUITE
// ============================================================================

describe('PhilipsAmbilightTVAccessory power handling', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(m => m.mockClear());
    mocks.setPowerState.mockResolvedValue(true);
    mocks.getVisibleSources.mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Let the accessory's fire-and-forget async work (fetch → getCurrentActivity) settle. */
  const flush = async () => {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
  };

  /** Drive the HomeKit "Active" (power) characteristic through its onSet handler. */
  async function setPower(services: Map<unknown, ReturnType<typeof createMockService>>, on: boolean) {
    const tvService = services.get(Service.Television)!;
    const activeChar = tvService.getCharacteristic(Characteristic.Active) as unknown as MockCharacteristic;
    await activeChar._onSet!(on ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
  }

  it('resets the source switches immediately when the TV is turned off from HomeKit', async () => {
    const { platform, accessory, services } = createMocks();
    new PhilipsAmbilightTVAccessory(platform as never, accessory as never);

    // TV starts off; turn it on first so the subsequent off is a real transition.
    await setPower(services, true);
    expect(mocks.resetAll).not.toHaveBeenCalled();

    // Turn it off from HomeKit — switches must reset now, not on the next poll.
    await setPower(services, false);

    expect(mocks.setPowerState).toHaveBeenLastCalledWith(false);
    expect(mocks.resetAll).toHaveBeenCalledTimes(1);
    expect(mocks.reflectPowerOff).toHaveBeenCalledTimes(1);
  });

  it('does not reset the switches when the TV is turned on', async () => {
    const { platform, accessory, services } = createMocks();
    new PhilipsAmbilightTVAccessory(platform as never, accessory as never);

    await setPower(services, true);

    expect(mocks.setPowerState).toHaveBeenLastCalledWith(true);
    expect(mocks.resetAll).not.toHaveBeenCalled();
  });

  it('does not reset again when the TV is already off', async () => {
    const { platform, accessory, services } = createMocks();
    new PhilipsAmbilightTVAccessory(platform as never, accessory as never);

    // Already off — this is a no-op and must not touch the switches or the TV.
    await setPower(services, false);

    expect(mocks.setPowerState).not.toHaveBeenCalled();
    expect(mocks.resetAll).not.toHaveBeenCalled();
  });

  describe('active-source sync on power-on', () => {
    /** Build the accessory and return the poll callbacks it registered. */
    function build() {
      const { platform, accessory } = createMocks();
      new PhilipsAmbilightTVAccessory(platform as never, accessory as never);
      return capture.pollCallbacks as { onPowerChange: (on: boolean) => void };
    }

    it('applies the current source to inputs and switches when the TV wakes', async () => {
      mocks.getCurrentActivity.mockResolvedValue('com.disney.disneyplus');
      const cb = build();

      // First power event is the initial sync (skipped); the second is a real wake.
      cb.onPowerChange(true);
      cb.onPowerChange(true);
      await flush();

      expect(mocks.fetchAppsFromTV).toHaveBeenCalled();
      expect(mocks.inputUpdateFromPoll).toHaveBeenCalledWith('com.disney.disneyplus', expect.anything());
      expect(mocks.switchUpdateFromPoll).toHaveBeenCalledWith('com.disney.disneyplus');
    });

    it('does not sync on the initial power event (Homebridge restart while TV on)', async () => {
      mocks.getCurrentActivity.mockResolvedValue('com.disney.disneyplus');
      const cb = build();

      cb.onPowerChange(true); // initial sync only
      await flush();

      expect(mocks.switchUpdateFromPoll).not.toHaveBeenCalled();
    });
  });
});
