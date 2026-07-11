import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SourceSwitchService } from '../../src/services/SourceSwitchService.js';
import type { SourceSwitchDeps } from '../../src/services/SourceSwitchService.js';

// ============================================================================
// MOCKS
// ============================================================================

function createMockService(subtype?: string) {
  const characteristics = new Map<string, { value: unknown; onGet: ReturnType<typeof vi.fn>; onSet: ReturnType<typeof vi.fn> }>();

  const service = {
    UUID: 'switch-uuid',
    subtype,
    setCharacteristic: vi.fn().mockReturnThis(),
    addOptionalCharacteristic: vi.fn(),
    getCharacteristic: vi.fn().mockImplementation((char: { UUID?: string } | string) => {
      const key = typeof char === 'string' ? char : char?.UUID ?? 'unknown';
      if (!characteristics.has(key)) {
        const c = {
          value: null as unknown,
          onGet: vi.fn().mockReturnThis(),
          onSet: vi.fn().mockReturnThis(),
        };
        characteristics.set(key, c);
      }
      return characteristics.get(key)!;
    }),
    updateCharacteristic: vi.fn().mockReturnThis(),
  };

  return service;
}

function createMockDeps(): SourceSwitchDeps {
  return {
    Service: {
      Switch: { UUID: 'switch-uuid' },
    } as never,
    Characteristic: {
      Name: { UUID: 'name' },
      ConfiguredName: { UUID: 'configured-name' },
      On: { UUID: 'on' },
    } as never,
    tvClient: {
      launchApplication: vi.fn().mockResolvedValue(true),
      setSource: vi.fn().mockResolvedValue(true),
      setChannel: vi.fn().mockResolvedValue(true),
      sendKey: vi.fn().mockResolvedValue(true),
      launchWatchTV: vi.fn().mockResolvedValue(true),
      launchHome: vi.fn().mockResolvedValue(true),
    } as never,
    communicationError: () => new Error('comm error') as never,
    log: vi.fn(),
    onSourceSwitch: vi.fn(),
  };
}

function createMockAccessory() {
  const services: ReturnType<typeof createMockService>[] = [];
  return {
    services,
    getServiceById: vi.fn().mockReturnValue(null),
    addService: vi.fn().mockImplementation((_svc: unknown, _name: string, subtype: string) => {
      const service = createMockService(subtype);
      services.push(service);
      return service;
    }),
    removeService: vi.fn(),
  };
}

const TEST_SOURCES = [
  { id: 'com.netflix.ninja', name: 'Netflix', type: 'app' as const },
  { id: 'content://android.media.tv/passthrough/HW5', name: 'HDMI 1', type: 'source' as const },
  { id: '42', name: 'BBC One', type: 'channel' as const, channelListId: 'allcab' },
];

// ============================================================================
// TEST SUITE
// ============================================================================

describe('SourceSwitchService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // CONFIGURATION
  // ==========================================================================

  describe('configureSwitches', () => {
    it('should create a Switch service for each source', () => {
      const deps = createMockDeps();
      const service = new SourceSwitchService(deps);
      const accessory = createMockAccessory();

      service.configureSwitches(accessory as never, TEST_SOURCES, 'TV');

      expect(accessory.addService).toHaveBeenCalledTimes(3);
    });

    it('should remove stale switch services', () => {
      const deps = createMockDeps();
      const service = new SourceSwitchService(deps);
      const accessory = createMockAccessory();

      // Add a stale switch service
      const staleService = createMockService('source-switch-com.old.app');
      staleService.UUID = 'switch-uuid';
      accessory.services.push(staleService);

      service.configureSwitches(accessory as never, TEST_SOURCES, 'TV');

      expect(accessory.removeService).toHaveBeenCalledWith(staleService);
    });

    it('should reuse existing switch services', () => {
      const deps = createMockDeps();
      const service = new SourceSwitchService(deps);
      const accessory = createMockAccessory();

      const existingService = createMockService('source-switch-com.netflix.ninja');
      accessory.getServiceById = vi.fn().mockImplementation((_svc: unknown, subtype: string) => {
        return subtype === 'source-switch-com.netflix.ninja' ? existingService : null;
      });

      service.configureSwitches(accessory as never, TEST_SOURCES, 'TV');

      // Should only add 2 new services (HDMI and channel), reuse Netflix
      expect(accessory.addService).toHaveBeenCalledTimes(2);
    });

    it('is idempotent when re-run after the input list changes (issue #14)', () => {
      const deps = createMockDeps();
      const service = new SourceSwitchService(deps);

      // Stateful accessory: getServiceById returns previously-added services,
      // like real Homebridge — so a re-run reuses services instead of duplicating.
      const services: ReturnType<typeof createMockService>[] = [];
      const accessory = {
        services,
        getServiceById: vi.fn().mockImplementation((_svc: unknown, subtype: string) =>
          services.find(s => s.subtype === subtype) ?? null),
        addService: vi.fn().mockImplementation((_svc: unknown, _name: string, subtype: string) => {
          const s = createMockService(subtype);
          services.push(s);
          return s;
        }),
        removeService: vi.fn(),
      };

      // First pass: TV asleep, only the HDMI source known.
      service.configureSwitches(accessory as never, [TEST_SOURCES[1]], 'TV');
      // Second pass: TV woke, full list discovered — switches refreshed.
      service.configureSwitches(accessory as never, TEST_SOURCES, 'TV');

      // All three switch services now exist, with no duplicate service objects.
      expect(services.length).toBe(3);

      // Internal registry must not have accumulated duplicates: resetAll touches
      // each switch's On characteristic exactly once.
      service.resetAll();
      for (const s of services) {
        expect(s.updateCharacteristic).toHaveBeenCalledTimes(1);
      }
    });
  });

  // ==========================================================================
  // SWITCH HANDLERS
  // ==========================================================================

  describe('switch ON', () => {
    it('should launch an app when its switch is turned on', async () => {
      const deps = createMockDeps();
      const service = new SourceSwitchService(deps);
      const accessory = createMockAccessory();

      service.configureSwitches(accessory as never, TEST_SOURCES, 'TV');

      // Get the onSet handler for Netflix switch
      const netflixSwitch = accessory.services.find(s => s.subtype === 'source-switch-com.netflix.ninja')!;
      const onChar = netflixSwitch.getCharacteristic({ UUID: 'on' });
      const onSetHandler = onChar.onSet.mock.calls[0][0] as (v: unknown) => Promise<void>;

      await onSetHandler(true);

      expect(deps.tvClient.launchApplication).toHaveBeenCalledWith('com.netflix.ninja', undefined, undefined);
    });

    it('should call onSourceSwitch callback after successful switch', async () => {
      const deps = createMockDeps();
      const service = new SourceSwitchService(deps);
      const accessory = createMockAccessory();

      service.configureSwitches(accessory as never, TEST_SOURCES, 'TV');

      const netflixSwitch = accessory.services.find(s => s.subtype === 'source-switch-com.netflix.ninja')!;
      const onChar = netflixSwitch.getCharacteristic({ UUID: 'on' });
      const onSetHandler = onChar.onSet.mock.calls[0][0] as (v: unknown) => Promise<void>;

      await onSetHandler(true);

      expect(deps.onSourceSwitch).toHaveBeenCalledWith('com.netflix.ninja');
    });

    it('should set source when an HDMI switch is turned on', async () => {
      const deps = createMockDeps();
      const service = new SourceSwitchService(deps);
      const accessory = createMockAccessory();

      service.configureSwitches(accessory as never, TEST_SOURCES, 'TV');

      const hdmiSwitch = accessory.services.find(s => s.subtype === 'source-switch-content://android.media.tv/passthrough/HW5')!;
      const onChar = hdmiSwitch.getCharacteristic({ UUID: 'on' });
      const onSetHandler = onChar.onSet.mock.calls[0][0] as (v: unknown) => Promise<void>;

      await onSetHandler(true);

      expect(deps.tvClient.setSource).toHaveBeenCalledWith('content://android.media.tv/passthrough/HW5');
    });

    it('should launch Home screen via sendKey when Home switch is turned on', async () => {
      const deps = createMockDeps();
      const service = new SourceSwitchService(deps);
      const accessory = createMockAccessory();

      const sources = [
        { id: 'virtual:home', name: 'Home', type: 'source' as const },
      ];

      service.configureSwitches(accessory as never, sources, 'TV');

      const homeSwitch = accessory.services.find(s => s.subtype === 'source-switch-virtual:home')!;
      const onChar = homeSwitch.getCharacteristic({ UUID: 'on' });
      const onSetHandler = onChar.onSet.mock.calls[0][0] as (v: unknown) => Promise<void>;

      await onSetHandler(true);

      expect(deps.tvClient.launchHome).toHaveBeenCalled();
      expect(deps.tvClient.setSource).not.toHaveBeenCalled();
    });

    it('should activate TV tuner before switching to a channel', async () => {
      const deps = createMockDeps();
      const service = new SourceSwitchService(deps);
      const accessory = createMockAccessory();

      service.configureSwitches(accessory as never, TEST_SOURCES, 'TV');

      const channelSwitch = accessory.services.find(s => s.subtype === 'source-switch-42')!;
      const onChar = channelSwitch.getCharacteristic({ UUID: 'on' });
      const onSetHandler = onChar.onSet.mock.calls[0][0] as (v: unknown) => Promise<void>;

      await onSetHandler(true);

      expect(deps.tvClient.launchWatchTV).toHaveBeenCalled();
      expect(deps.tvClient.setChannel).toHaveBeenCalledWith(42, 'allcab');
    });
  });

  // ==========================================================================
  // POLL UPDATES
  // ==========================================================================

  describe('updateFromPoll', () => {
    it('should turn on the matching switch and turn off others', () => {
      const deps = createMockDeps();
      const service = new SourceSwitchService(deps);
      const accessory = createMockAccessory();

      service.configureSwitches(accessory as never, TEST_SOURCES, 'TV');

      service.updateFromPoll('com.netflix.ninja');

      const netflixSwitch = accessory.services.find(s => s.subtype === 'source-switch-com.netflix.ninja')!;
      expect(netflixSwitch.updateCharacteristic).toHaveBeenCalledWith({ UUID: 'on' }, true);
    });

    it('should ignore unrecognized source IDs from poll', () => {
      const deps = createMockDeps();
      const service = new SourceSwitchService(deps);
      const accessory = createMockAccessory();

      service.configureSwitches(accessory as never, TEST_SOURCES, 'TV');

      // Activate Netflix via poll
      service.updateFromPoll('com.netflix.ninja');
      accessory.services.forEach(s => s.updateCharacteristic.mockClear());

      // Poll returns a system package name that doesn't match any switch
      service.updateFromPoll('org.droidtv.playtv');

      // Should not change any switch state — Netflix stays ON
      accessory.services.forEach(s => {
        expect(s.updateCharacteristic).not.toHaveBeenCalled();
      });
    });

    it('should not update if source has not changed', () => {
      const deps = createMockDeps();
      const service = new SourceSwitchService(deps);
      const accessory = createMockAccessory();

      service.configureSwitches(accessory as never, TEST_SOURCES, 'TV');

      service.updateFromPoll('com.netflix.ninja');
      // Clear mock calls
      accessory.services.forEach(s => s.updateCharacteristic.mockClear());

      service.updateFromPoll('com.netflix.ninja');

      // Should not update since nothing changed
      accessory.services.forEach(s => {
        expect(s.updateCharacteristic).not.toHaveBeenCalled();
      });
    });
  });

  // ==========================================================================
  // RESET
  // ==========================================================================

  describe('resetAll', () => {
    it('should turn off all switches', () => {
      const deps = createMockDeps();
      const service = new SourceSwitchService(deps);
      const accessory = createMockAccessory();

      service.configureSwitches(accessory as never, TEST_SOURCES, 'TV');
      service.updateFromPoll('com.netflix.ninja');

      service.resetAll();

      for (const sw of accessory.services) {
        expect(sw.updateCharacteristic).toHaveBeenCalledWith({ UUID: 'on' }, false);
      }
    });
  });
});
