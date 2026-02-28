import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InputSourceManager } from '../../services/InputSourceManager.js';
import type { InputSourceManagerDeps } from '../../services/InputSourceManager.js';

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
}));

import fs from 'fs';

const mockReadFileSync = vi.mocked(fs.readFileSync);

// ============================================================================
// HOMEKIT MOCK HELPERS
// ============================================================================

function createMockCharacteristic() {
  const values = new Map<string, unknown>();
  const handlers = new Map<string, { onGet?: () => unknown; onSet?: (v: unknown) => void }>();

  const makeCharacteristic = (name: string) => {
    const char = {
      value: values.get(name) ?? null,
      onGet: vi.fn().mockImplementation((fn: () => unknown) => {
        handlers.set(name, { ...handlers.get(name), onGet: fn });
        return char;
      }),
      onSet: vi.fn().mockImplementation((fn: (v: unknown) => void) => {
        handlers.set(name, { ...handlers.get(name), onSet: fn });
        return char;
      }),
      updateValue: vi.fn().mockImplementation((v: unknown) => {
        values.set(name, v);
        char.value = v;
        return char;
      }),
      setProps: vi.fn().mockReturnThis(),
    };
    return char;
  };

  return {
    makeCharacteristic,
    values,
    handlers,
  };
}

function createMockService(subtype?: string) {
  const characteristics = new Map<string, ReturnType<ReturnType<typeof createMockCharacteristic>['makeCharacteristic']>>();
  const linkedServices: unknown[] = [];

  const service = {
    UUID: 'inputsource-uuid',
    subtype,
    setCharacteristic: vi.fn().mockReturnThis(),
    getCharacteristic: vi.fn().mockImplementation((char: { UUID?: string } | string) => {
      const key = typeof char === 'string' ? char : char?.UUID ?? 'unknown';
      if (!characteristics.has(key)) {
        const helper = createMockCharacteristic();
        characteristics.set(key, helper.makeCharacteristic(key));
      }
      return characteristics.get(key)!;
    }),
    updateCharacteristic: vi.fn().mockReturnThis(),
    addLinkedService: vi.fn().mockImplementation((s: unknown) => linkedServices.push(s)),
  };

  return service;
}

function createMockDeps(overrides?: Partial<InputSourceManagerDeps>): InputSourceManagerDeps {
  const services: ReturnType<typeof createMockService>[] = [];
  const accessory = {
    context: {} as Record<string, unknown>,
    services,
    getService: vi.fn().mockReturnValue(null),
    getServiceById: vi.fn().mockReturnValue(null),
    addService: vi.fn().mockImplementation((_svc: unknown, _name: string, subtype: string) => {
      const service = createMockService(subtype);
      services.push(service);
      return service;
    }),
    removeService: vi.fn(),
  };

  // Create Characteristic enum-like object
  const Char = {
    ConfiguredName: { UUID: 'configured-name' },
    CurrentVisibilityState: { UUID: 'current-visibility', SHOWN: 0, HIDDEN: 1 },
    TargetVisibilityState: { UUID: 'target-visibility' },
    InputSourceType: { UUID: 'input-source-type', HDMI: 3, APPLICATION: 10 },
    IsConfigured: { UUID: 'is-configured', CONFIGURED: 1 },
    Name: { UUID: 'name' },
    Identifier: { UUID: 'identifier' },
    DisplayOrder: { UUID: 'display-order' },
    ActiveIdentifier: { UUID: 'active-identifier' },
  };

  const Svc = {
    InputSource: { UUID: 'inputsource-uuid' },
  };

  return {
    Service: Svc as never,
    Characteristic: Char as never,
    tvClient: {
      getApplications: vi.fn().mockResolvedValue([]),
      launchApplication: vi.fn().mockResolvedValue(true),
      setSource: vi.fn().mockResolvedValue(true),
      setChannel: vi.fn().mockResolvedValue(true),
      sendKey: vi.fn().mockResolvedValue(true),
    } as never,
    accessory: accessory as never,
    storagePath: '/tmp/test',
    deviceId: 'AA:BB:CC:DD:EE:FF',
    communicationError: () => new Error('comm error') as never,
    log: vi.fn(),
    ...overrides,
  };
}

// ============================================================================
// TEST SUITE
// ============================================================================

describe('InputSourceManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockReadFileSync.mockReset().mockImplementation(() => {
      throw new Error('ENOENT');
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // CONFIGURATION
  // ==========================================================================

  describe('configureInputSources', () => {
    it('should create static sources (Watch TV + HDMI 1-4)', () => {
      const deps = createMockDeps();
      const manager = new InputSourceManager(deps);
      const tvService = createMockService();

      manager.configureInputSources(tvService as never);

      const sources = manager.getSources();
      expect(sources.length).toBe(5); // Watch TV + HDMI 1-4
      expect(sources[0].name).toBe('Watch TV');
    });

    it('should add user-configured inputs after static sources', () => {
      const deps = createMockDeps({
        userInputs: [
          { identifier: 'com.netflix.ninja', name: 'Netflix', type: 'app' },
          { identifier: 'com.youtube', name: 'YouTube', type: 'app' },
        ],
      });
      const manager = new InputSourceManager(deps);
      const tvService = createMockService();

      manager.configureInputSources(tvService as never);

      const sources = manager.getSources();
      expect(sources.length).toBe(7); // 5 static + 2 apps
      expect(sources[5].name).toBe('Netflix');
      expect(sources[6].name).toBe('YouTube');
    });

    it('should load cached inputs from disk', () => {
      const cachedConfigs = [
        { id: 'com.netflix.ninja', name: 'Netflix', configuredName: 'Netflix', type: 'app', identifier: 6, visibility: 0 },
      ];
      mockReadFileSync.mockReturnValue(JSON.stringify(cachedConfigs));

      const deps = createMockDeps();
      const manager = new InputSourceManager(deps);
      const tvService = createMockService();

      manager.configureInputSources(tvService as never);

      const sources = manager.getSources();
      // 5 static + 1 cached app
      expect(sources.length).toBe(6);
      expect(sources[5].id).toBe('com.netflix.ninja');
    });

    it('should respect MAX_INPUT_SOURCES limit', () => {
      const deps = createMockDeps({
        userInputs: Array.from({ length: 50 }, (_, i) => ({
          identifier: `app-${i}`,
          name: `App ${i}`,
          type: 'app' as const,
        })),
      });
      const manager = new InputSourceManager(deps);
      const tvService = createMockService();

      manager.configureInputSources(tvService as never);

      // Should be capped at 30 (5 static + 25 apps)
      expect(manager.getSources().length).toBeLessThanOrEqual(30);
    });
  });

  // ==========================================================================
  // APP DISCOVERY
  // ==========================================================================

  describe('fetchAppsFromTV', () => {
    it('should discover new apps from TV', async () => {
      const deps = createMockDeps();
      (deps.tvClient.getApplications as ReturnType<typeof vi.fn>).mockResolvedValue([
        { label: 'Netflix', intent: { component: { packageName: 'com.netflix.ninja' } } },
        { label: 'YouTube', intent: { component: { packageName: 'com.youtube' } } },
      ]);

      const manager = new InputSourceManager(deps);
      const tvService = createMockService();
      manager.configureInputSources(tvService as never);

      await manager.fetchAppsFromTV();

      const sources = manager.getSources();
      expect(sources.length).toBe(7); // 5 static + 2 apps
    });

    it('should skip discovery when user has configured inputs', async () => {
      const deps = createMockDeps({
        userInputs: [{ identifier: 'com.test', name: 'Test', type: 'app' }],
      });

      const manager = new InputSourceManager(deps);
      const tvService = createMockService();
      manager.configureInputSources(tvService as never);

      await manager.fetchAppsFromTV();

      // Should not call getApplications
      expect(deps.tvClient.getApplications).not.toHaveBeenCalled();
    });

    it('should exclude system packages', async () => {
      const deps = createMockDeps();
      (deps.tvClient.getApplications as ReturnType<typeof vi.fn>).mockResolvedValue([
        { label: 'Netflix', intent: { component: { packageName: 'com.netflix.ninja' } } },
        { label: 'Launcher', intent: { component: { packageName: 'com.google.android.tvlauncher' } } },
        { label: 'Settings', intent: { component: { packageName: 'com.android.tv.settings' } } },
      ]);

      const manager = new InputSourceManager(deps);
      const tvService = createMockService();
      manager.configureInputSources(tvService as never);

      await manager.fetchAppsFromTV();

      const appSources = manager.getSources().filter(s => s.type === 'app');
      expect(appSources.length).toBe(1);
      expect(appSources[0].id).toBe('com.netflix.ninja');
    });

    it('should not add duplicate apps', async () => {
      const deps = createMockDeps();
      (deps.tvClient.getApplications as ReturnType<typeof vi.fn>).mockResolvedValue([
        { label: 'Netflix', intent: { component: { packageName: 'com.netflix.ninja' } } },
      ]);

      const manager = new InputSourceManager(deps);
      const tvService = createMockService();
      manager.configureInputSources(tvService as never);

      // Discover twice
      await manager.fetchAppsFromTV();
      await manager.fetchAppsFromTV();

      const appSources = manager.getSources().filter(s => s.type === 'app');
      expect(appSources.length).toBe(1);
    });
  });

  // ==========================================================================
  // INPUT HANDLERS
  // ==========================================================================

  describe('handleGetInput', () => {
    it('should return current input identifier', () => {
      const deps = createMockDeps();
      const manager = new InputSourceManager(deps);

      expect(manager.handleGetInput()).toBe(1);
    });
  });

  describe('handleSetInput', () => {
    it('should switch to the selected source', async () => {
      const deps = createMockDeps();
      const manager = new InputSourceManager(deps);
      const tvService = createMockService();
      manager.configureInputSources(tvService as never);

      // Get the actual identifier for Watch TV (assigned dynamically)
      const watchTV = manager.getSources().find(s => s.name === 'Watch TV')!;
      await manager.handleSetInput(watchTV.identifier);
      expect(deps.tvClient.setSource).toHaveBeenCalled();
    });

    it('should throw for unknown identifier', async () => {
      const deps = createMockDeps();
      const manager = new InputSourceManager(deps);
      const tvService = createMockService();
      manager.configureInputSources(tvService as never);

      await expect(manager.handleSetInput(999)).rejects.toThrow();
    });
  });

  // ==========================================================================
  // REMOTE KEY HANDLER
  // ==========================================================================

  describe('handleRemoteKey', () => {
    it('should send mapped key to TV', async () => {
      const deps = createMockDeps();
      const manager = new InputSourceManager(deps);

      // Key 4 = CursorUp
      await manager.handleRemoteKey(4);
      expect(deps.tvClient.sendKey).toHaveBeenCalledWith('CursorUp');
    });

    it('should ignore unmapped keys', async () => {
      const deps = createMockDeps();
      const manager = new InputSourceManager(deps);

      await manager.handleRemoteKey(99);
      expect(deps.tvClient.sendKey).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // POLL UPDATES
  // ==========================================================================

  describe('updateFromPoll', () => {
    it('should update current input from poll data', () => {
      const deps = createMockDeps({
        userInputs: [{ identifier: 'com.netflix.ninja', name: 'Netflix', type: 'app' }],
      });
      const manager = new InputSourceManager(deps);
      const tvService = createMockService();
      manager.configureInputSources(tvService as never);

      const netflixSource = manager.getSources().find(s => s.id === 'com.netflix.ninja');
      expect(netflixSource).toBeDefined();

      manager.updateFromPoll('com.netflix.ninja', tvService as never);
      expect(manager.currentId).toBe(netflixSource!.identifier);
    });

    it('should not update for unknown apps', () => {
      const deps = createMockDeps();
      const manager = new InputSourceManager(deps);
      const tvService = createMockService();
      manager.configureInputSources(tvService as never);

      const initialId = manager.currentId;
      manager.updateFromPoll('com.unknown.app', tvService as never);
      expect(manager.currentId).toBe(initialId);
    });
  });
});
