import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InputSourceManager } from '../../src/services/InputSourceManager.js';
import type { InputSourceManagerDeps } from '../../src/services/InputSourceManager.js';

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
      launchWatchTV: vi.fn().mockResolvedValue(true),
      launchHome: vi.fn().mockResolvedValue(true),
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
    it('should create static sources (Watch TV + Home + HDMI 1-4)', () => {
      const deps = createMockDeps();
      const manager = new InputSourceManager(deps);
      const tvService = createMockService();

      manager.configureInputSources(tvService as never);

      const sources = manager.getSources();
      expect(sources.length).toBe(6); // Watch TV + Home + HDMI 1-4
      expect(sources[0].name).toBe('Watch TV');
      expect(sources[1].name).toBe('Home');
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
      expect(sources.length).toBe(8); // 6 static + 2 apps
      expect(sources[6].name).toBe('Netflix');
      expect(sources[7].name).toBe('YouTube');
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
      // 6 static + 1 cached app
      expect(sources.length).toBe(7);
      expect(sources[6].id).toBe('com.netflix.ninja');
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

      // Should be capped at 30 (6 static + 24 apps)
      expect(manager.getSources().length).toBeLessThanOrEqual(30);
    });

    it('should prioritize user-configured visible sources within the MAX_INPUT_SOURCES cap', () => {
      // 25 regular cached apps would fill all 24 available app slots (30 cap - 6 static),
      // leaving no room for the 3 visible apps at the end without priority sorting.
      const regularApps = Array.from({ length: 25 }, (_, i) => ({
        id: `com.app.${String(i).padStart(3, '0')}`,
        name: `App ${i}`,
        configuredName: `App ${i}`,
        type: 'app' as const,
        identifier: 10 + i,
        visibility: 0,
      }));
      const visibleIds = ['com.important.a', 'com.important.b', 'com.important.c'];
      const allCached = [
        ...regularApps,
        ...visibleIds.map((id, i) => ({
          id,
          name: `Important ${i}`,
          configuredName: `Important ${i}`,
          type: 'app' as const,
          identifier: 100 + i,
          visibility: 0,
        })),
      ];

      mockReadFileSync.mockReturnValue(JSON.stringify(allCached));

      const deps = createMockDeps({
        sourceConfigs: visibleIds.map(id => ({ id, visible: true })),
      });
      const manager = new InputSourceManager(deps);
      const tvService = createMockService();

      manager.configureInputSources(tvService as never);

      const sources = manager.getSources();
      expect(sources.length).toBeLessThanOrEqual(30);

      // All 3 explicitly-visible sources must be registered despite being last in cache order
      for (const id of visibleIds) {
        expect(sources.some(s => s.id === id)).toBe(true);
      }
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
      expect(sources.length).toBe(8); // 6 static + 2 apps
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

    it('should keep an excluded package when the user marks it visible', async () => {
      const deps = createMockDeps({
        sourceConfigs: [{ id: 'com.android.vending', visible: true }],
      });
      (deps.tvClient.getApplications as ReturnType<typeof vi.fn>).mockResolvedValue([
        { label: 'Netflix', intent: { component: { packageName: 'com.netflix.ninja' } } },
        { label: 'Google Play', intent: { component: { packageName: 'com.android.vending' } } },
        { label: 'Launcher', intent: { component: { packageName: 'com.google.android.tvlauncher' } } },
      ]);

      const manager = new InputSourceManager(deps);
      const tvService = createMockService();
      manager.configureInputSources(tvService as never);

      await manager.fetchAppsFromTV();

      const appIds = manager.getSources().filter(s => s.type === 'app').map(s => s.id);
      // Explicitly-visible excluded package is kept; non-configured excluded one is still dropped
      expect(appIds).toContain('com.android.vending');
      expect(appIds).toContain('com.netflix.ninja');
      expect(appIds).not.toContain('com.google.android.tvlauncher');
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
  // VISIBLE SOURCE SEEDING (issue #14)
  // ==========================================================================

  describe('visible source seeding', () => {
    it('registers a visible source at boot even with no cache and an unreachable TV', () => {
      // Fresh install, TV asleep: no cache file, getApplications returns nothing.
      const deps = createMockDeps({
        sourceConfigs: [{ id: 'com.netflix.ninja', visible: true, customName: 'Netflix' }],
      });
      const manager = new InputSourceManager(deps);
      const tvService = createMockService();

      manager.configureInputSources(tvService as never);

      const seeded = manager.getSources().find(s => s.id === 'com.netflix.ninja');
      expect(seeded).toBeDefined();
      expect(seeded!.type).toBe('app');
      expect(seeded!.name).toBe('Netflix');
    });

    it('does not seed sources the user marked hidden', () => {
      const deps = createMockDeps({
        sourceConfigs: [{ id: 'com.netflix.ninja', visible: false }],
      });
      const manager = new InputSourceManager(deps);
      manager.configureInputSources(createMockService() as never);

      expect(manager.getSources().some(s => s.id === 'com.netflix.ninja')).toBe(false);
    });

    it('does not double-register static sources present in the sources config', () => {
      const deps = createMockDeps({
        sourceConfigs: [
          { id: 'content://android.media.tv/channel', visible: true }, // Watch TV
          // HDMI 1 (real passthrough URI as reported by the TV)
          { id: 'content://android.media.tv/passthrough/com.mediatek.tvinput%2F.hdmi.HDMIInputService%2FHW5', visible: true },
        ],
      });
      const manager = new InputSourceManager(deps);
      manager.configureInputSources(createMockService() as never);

      // Static sources are added by getStaticSources — the seeding step must not
      // add a second app-typed copy.
      const watchTv = manager.getSources().filter(s => s.id === 'content://android.media.tv/channel');
      expect(watchTv.length).toBe(1);
      expect(watchTv[0].type).toBe('source');
      // 6 static sources only, no stray app entries.
      expect(manager.getSources().filter(s => s.type === 'app').length).toBe(0);
    });

    it('falls back to the id as the name when no customName is set', () => {
      const deps = createMockDeps({
        sourceConfigs: [{ id: 'com.disney.disneyplus', visible: true }],
      });
      const manager = new InputSourceManager(deps);
      manager.configureInputSources(createMockService() as never);

      const seeded = manager.getSources().find(s => s.id === 'com.disney.disneyplus');
      // The id is the fallback label, sanitized for HomeKit (dots → spaces).
      expect(seeded?.name).toBe('com disney disneyplus');
    });
  });

  // ==========================================================================
  // INPUT CHANGE NOTIFICATION (issue #14)
  // ==========================================================================

  describe('onInputsChanged', () => {
    it('fires once after apps are discovered from the TV', async () => {
      const onInputsChanged = vi.fn();
      const deps = createMockDeps({ onInputsChanged });
      (deps.tvClient.getApplications as ReturnType<typeof vi.fn>).mockResolvedValue([
        { label: 'Netflix', intent: { component: { packageName: 'com.netflix.ninja' } } },
      ]);

      const manager = new InputSourceManager(deps);
      manager.configureInputSources(createMockService() as never);

      await manager.fetchAppsFromTV();
      expect(onInputsChanged).toHaveBeenCalledTimes(1);
    });

    it('does not fire when discovery adds no new apps', async () => {
      const onInputsChanged = vi.fn();
      const deps = createMockDeps({ onInputsChanged });
      (deps.tvClient.getApplications as ReturnType<typeof vi.fn>).mockResolvedValue([
        { label: 'Netflix', intent: { component: { packageName: 'com.netflix.ninja' } } },
      ]);

      const manager = new InputSourceManager(deps);
      manager.configureInputSources(createMockService() as never);

      await manager.fetchAppsFromTV(); // adds Netflix → fires
      await manager.fetchAppsFromTV(); // nothing new → must not fire again
      expect(onInputsChanged).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // PLACEHOLDER NAME UPGRADE (issue #14)
  // ==========================================================================

  describe('upgradePlaceholderNames', () => {
    const CONFIGURED_NAME = { UUID: 'configured-name' } as never;

    it('upgrades a package-id placeholder to the real app label on discovery', async () => {
      const onInputsChanged = vi.fn();
      const deps = createMockDeps({
        sourceConfigs: [{ id: 'com.netflix.ninja', visible: true }],
        onInputsChanged,
      });
      const manager = new InputSourceManager(deps);
      manager.configureInputSources(createMockService() as never);

      // Seeded (TV asleep) → name is the sanitized package id, and the
      // ConfiguredName characteristic holds that same placeholder.
      const before = manager.getSources().find(s => s.id === 'com.netflix.ninja')!;
      expect(before.name).toBe('com netflix ninja');
      before.service.getCharacteristic(CONFIGURED_NAME).value = 'com netflix ninja';

      // TV wakes and reports the real label.
      (deps.tvClient.getApplications as ReturnType<typeof vi.fn>).mockResolvedValue([
        { label: 'Netflix', intent: { component: { packageName: 'com.netflix.ninja' } } },
      ]);
      await manager.fetchAppsFromTV();

      expect(manager.getSources().find(s => s.id === 'com.netflix.ninja')!.name).toBe('Netflix');
      expect(onInputsChanged).toHaveBeenCalled(); // switches refresh to pick up the name
    });

    it('does not override a user-set custom name', async () => {
      const deps = createMockDeps({
        sourceConfigs: [{ id: 'com.netflix.ninja', visible: true, customName: 'My Netflix' }],
      });
      const manager = new InputSourceManager(deps);
      manager.configureInputSources(createMockService() as never);

      (deps.tvClient.getApplications as ReturnType<typeof vi.fn>).mockResolvedValue([
        { label: 'Netflix', intent: { component: { packageName: 'com.netflix.ninja' } } },
      ]);
      await manager.fetchAppsFromTV();

      expect(manager.getSources().find(s => s.id === 'com.netflix.ninja')!.name).toBe('My Netflix');
    });

    it('does not override a name the user changed in HomeKit', async () => {
      const deps = createMockDeps({
        sourceConfigs: [{ id: 'com.netflix.ninja', visible: true }],
      });
      const manager = new InputSourceManager(deps);
      manager.configureInputSources(createMockService() as never);

      const before = manager.getSources().find(s => s.id === 'com.netflix.ninja')!;
      // User renamed the input in HomeKit → ConfiguredName differs from the placeholder.
      before.service.getCharacteristic(CONFIGURED_NAME).value = 'Films';

      (deps.tvClient.getApplications as ReturnType<typeof vi.fn>).mockResolvedValue([
        { label: 'Netflix', intent: { component: { packageName: 'com.netflix.ninja' } } },
      ]);
      await manager.fetchAppsFromTV();

      // Base name stays the placeholder; the user's HomeKit name is preserved.
      expect(manager.getSources().find(s => s.id === 'com.netflix.ninja')!.name).toBe('com netflix ninja');
    });
  });

  // ==========================================================================
  // GENERIC-NAME WRITE GUARD (tvOS HomeHub bug, issue #14)
  // ==========================================================================

  describe('ConfiguredName write guard', () => {
    const CONFIGURED_NAME = { UUID: 'configured-name' } as never;

    function handlersFor(service: { getCharacteristic: (c: unknown) => { onGet: ReturnType<typeof vi.fn>; onSet: ReturnType<typeof vi.fn> } }) {
      const char = service.getCharacteristic(CONFIGURED_NAME);
      return {
        onGet: char.onGet.mock.calls.at(-1)![0] as () => unknown,
        onSet: char.onSet.mock.calls.at(-1)![0] as (v: unknown) => void,
      };
    }

    function netflixHandlers() {
      const deps = createMockDeps({ sourceConfigs: [{ id: 'com.netflix.ninja', visible: true, customName: 'Netflix' }] });
      const manager = new InputSourceManager(deps);
      manager.configureInputSources(createMockService() as never);
      const svc = manager.getSources().find(s => s.id === 'com.netflix.ninja')!.service;
      return handlersFor(svc as never);
    }

    it.each([
      'Input Source',
      'Input Source 2',
      'Input',
      'Entrada 2', // Spanish (the string alfonsico reported)
      'Eingang 3', // German
      'Ingresso', // Italian, no index
      'Entrée 4', // French
      'вход 1', // Russian
    ])('ignores the localized generic placeholder %j', (generic) => {
      const { onGet, onSet } = netflixHandlers();
      onSet(generic);
      expect(onGet()).toBe('Netflix'); // real label preserved
    });

    it('accepts a genuine user rename', () => {
      const { onGet, onSet } = netflixHandlers();
      onSet('Netflix HD');
      expect(onGet()).toBe('Netflix HD');
    });
  });

  // ==========================================================================
  // CUSTOM APPS
  // ==========================================================================

  describe('custom apps', () => {
    const EON = { name: 'EON', packageName: 'com.ug.eon.android.tv', className: 'com.ug.eon.android.tv.MainActivity' };

    it('should expose custom apps additively alongside discovered apps', async () => {
      const deps = createMockDeps({ customApps: [EON] });
      (deps.tvClient.getApplications as ReturnType<typeof vi.fn>).mockResolvedValue([
        { label: 'Netflix', intent: { component: { packageName: 'com.netflix.ninja' } } },
      ]);

      const manager = new InputSourceManager(deps);
      const tvService = createMockService();
      manager.configureInputSources(tvService as never);
      await manager.fetchAppsFromTV();

      const appIds = manager.getSources().filter(s => s.type === 'app').map(s => s.id);
      expect(appIds).toContain('com.ug.eon.android.tv'); // custom app
      expect(appIds).toContain('com.netflix.ninja'); // discovered app
    });

    it('should expose custom apps even before the TV is reachable', () => {
      const deps = createMockDeps({ customApps: [EON] });
      const manager = new InputSourceManager(deps);
      const tvService = createMockService();
      manager.configureInputSources(tvService as never);

      const appIds = manager.getSources().filter(s => s.type === 'app').map(s => s.id);
      expect(appIds).toContain('com.ug.eon.android.tv');
    });

    it('should launch a custom app with its explicit className and action', async () => {
      const deps = createMockDeps({ customApps: [{ ...EON, action: 'android.intent.action.VIEW' }] });
      const manager = new InputSourceManager(deps);
      const tvService = createMockService();
      manager.configureInputSources(tvService as never);

      const eon = manager.getSources().find(s => s.id === 'com.ug.eon.android.tv')!;
      await manager.handleSetInput(eon.identifier);

      expect(deps.tvClient.launchApplication).toHaveBeenCalledWith(
        'com.ug.eon.android.tv',
        'com.ug.eon.android.tv.MainActivity',
        'android.intent.action.VIEW',
      );
    });

    it('should not duplicate a custom app the TV also reports', async () => {
      const deps = createMockDeps({ customApps: [EON] });
      (deps.tvClient.getApplications as ReturnType<typeof vi.fn>).mockResolvedValue([
        { label: 'EON (TV)', intent: { component: { packageName: 'com.ug.eon.android.tv' } } },
      ]);

      const manager = new InputSourceManager(deps);
      const tvService = createMockService();
      manager.configureInputSources(tvService as never);
      await manager.fetchAppsFromTV();

      const eonInputs = manager.getSources().filter(s => s.id === 'com.ug.eon.android.tv');
      expect(eonInputs.length).toBe(1);
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
      expect(deps.tvClient.launchWatchTV).toHaveBeenCalled();
    });

    it('should switch to Home screen via sendKey', async () => {
      const deps = createMockDeps();
      const manager = new InputSourceManager(deps);
      const tvService = createMockService();
      manager.configureInputSources(tvService as never);

      const home = manager.getSources().find(s => s.name === 'Home')!;
      await manager.handleSetInput(home.identifier);
      expect(deps.tvClient.launchHome).toHaveBeenCalled();
    });

    it('should activate TV tuner before switching to a channel', async () => {
      const deps = createMockDeps({
        userInputs: [{ identifier: '42', name: 'BBC One', type: 'channel' }],
      });
      const manager = new InputSourceManager(deps);
      const tvService = createMockService();
      manager.configureInputSources(tvService as never);

      const channelSource = manager.getSources().find(s => s.name === 'BBC One')!;
      await manager.handleSetInput(channelSource.identifier);

      // Should call launchWatchTV() first, then setChannel
      expect(deps.tvClient.launchWatchTV).toHaveBeenCalled();
      expect(deps.tvClient.setChannel).toHaveBeenCalledWith(42, undefined);

      // launchWatchTV should be called before setChannel
      const launchOrder = (deps.tvClient.launchWatchTV as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      const setChannelOrder = (deps.tvClient.setChannel as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      expect(launchOrder).toBeLessThan(setChannelOrder);
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

    it('should use default Back key when not configured', async () => {
      const deps = createMockDeps();
      const manager = new InputSourceManager(deps);

      await manager.handleRemoteKey(9);
      expect(deps.tvClient.sendKey).toHaveBeenCalledWith('Back');
    });

    it('should use default PlayPause key when not configured', async () => {
      const deps = createMockDeps();
      const manager = new InputSourceManager(deps);

      await manager.handleRemoteKey(11);
      expect(deps.tvClient.sendKey).toHaveBeenCalledWith('PlayPause');
    });

    it('should use default Source key for info button when not configured', async () => {
      const deps = createMockDeps();
      const manager = new InputSourceManager(deps);

      await manager.handleRemoteKey(15);
      expect(deps.tvClient.sendKey).toHaveBeenCalledWith('Source');
    });

    it('should use custom info button key when configured', async () => {
      const deps = createMockDeps({ infoButtonKey: 'Info' });
      const manager = new InputSourceManager(deps);

      await manager.handleRemoteKey(15);
      expect(deps.tvClient.sendKey).toHaveBeenCalledWith('Info');
    });

    it('should use custom back button key when configured', async () => {
      const deps = createMockDeps({ backButtonKey: 'Home' });
      const manager = new InputSourceManager(deps);

      await manager.handleRemoteKey(9);
      expect(deps.tvClient.sendKey).toHaveBeenCalledWith('Home');
    });

    it('should use custom play/pause button key when configured', async () => {
      const deps = createMockDeps({ playPauseButtonKey: 'Source' });
      const manager = new InputSourceManager(deps);

      await manager.handleRemoteKey(11);
      expect(deps.tvClient.sendKey).toHaveBeenCalledWith('Source');
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

  // ==========================================================================
  // SET ACTIVE INPUT BY ID
  // ==========================================================================

  describe('setActiveInputById', () => {
    it('should update ActiveIdentifier from a source ID', () => {
      const deps = createMockDeps({
        userInputs: [{ identifier: 'com.netflix.ninja', name: 'Netflix', type: 'app' }],
      });
      const manager = new InputSourceManager(deps);
      const tvService = createMockService();
      manager.configureInputSources(tvService as never);

      const netflixSource = manager.getSources().find(s => s.id === 'com.netflix.ninja');
      manager.setActiveInputById('com.netflix.ninja');

      expect(manager.currentId).toBe(netflixSource!.identifier);
      expect(tvService.updateCharacteristic).toHaveBeenCalled();
    });

    it('should ignore unknown source IDs', () => {
      const deps = createMockDeps();
      const manager = new InputSourceManager(deps);
      const tvService = createMockService();
      manager.configureInputSources(tvService as never);

      const initialId = manager.currentId;
      manager.setActiveInputById('com.unknown.app');

      expect(manager.currentId).toBe(initialId);
    });
  });

  // ==========================================================================
  // MANUAL SWITCH CONFIRMATION (issue #14 — wheel bounce)
  // ==========================================================================

  describe('manual switch confirmation', () => {
    const ACTIVE_IDENTIFIER = { UUID: 'active-identifier' } as never;

    function twoAppManager() {
      const deps = createMockDeps({
        userInputs: [
          { identifier: 'com.netflix.ninja', name: 'Netflix', type: 'app' },
          { identifier: 'com.disney.disneyplus', name: 'Disney+', type: 'app' },
        ],
      });
      const manager = new InputSourceManager(deps);
      const tvService = createMockService();
      manager.configureInputSources(tvService as never);
      const netflix = manager.getSources().find(s => s.id === 'com.netflix.ninja')!;
      const disney = manager.getSources().find(s => s.id === 'com.disney.disneyplus')!;
      return { manager, tvService, netflix, disney };
    }

    it('confirms the selection on ActiveIdentifier after a successful switch', async () => {
      const { manager, tvService, disney } = twoAppManager();
      await manager.handleSetInput(disney.identifier);
      expect(tvService.updateCharacteristic).toHaveBeenCalledWith(ACTIVE_IDENTIFIER, disney.identifier);
    });

    it('ignores polls reporting the previous app until the TV confirms the switch', async () => {
      const { manager, tvService, disney } = twoAppManager();
      await manager.handleSetInput(disney.identifier);
      expect(manager.currentId).toBe(disney.identifier);

      // TV still reports the old app for a couple of polls — must not bounce back.
      manager.updateFromPoll('com.netflix.ninja', tvService as never);
      manager.updateFromPoll('com.netflix.ninja', tvService as never);
      expect(manager.currentId).toBe(disney.identifier);
    });

    it('resumes tracking once the TV confirms the pending switch', async () => {
      const { manager, tvService, netflix, disney } = twoAppManager();
      await manager.handleSetInput(disney.identifier);

      manager.updateFromPoll('com.disney.disneyplus', tvService as never); // confirmed
      expect(manager.currentId).toBe(disney.identifier);

      // A genuine change on the TV is reflected again after confirmation.
      manager.updateFromPoll('com.netflix.ninja', tvService as never);
      expect(manager.currentId).toBe(netflix.identifier);
    });

    it('gives up after the confirmation timeout so a failed switch is still reflected', async () => {
      const { manager, tvService, netflix, disney } = twoAppManager();
      await manager.handleSetInput(disney.identifier);

      // Contradicting polls are ignored while the TV may still be switching,
      // no matter how many arrive (the long-poll can deliver several quickly)...
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(1000);
        manager.updateFromPoll('com.netflix.ninja', tvService as never);
        expect(manager.currentId).toBe(disney.identifier);
      }
      // ...but once the timeout elapses the TV's report is accepted.
      vi.advanceTimersByTime(15_000);
      manager.updateFromPoll('com.netflix.ninja', tvService as never);
      expect(manager.currentId).toBe(netflix.identifier);
    });

    it('reports a successful wheel switch to onInputSwitched so switches align immediately', async () => {
      const onInputSwitched = vi.fn();
      const deps = createMockDeps({
        userInputs: [{ identifier: 'com.netflix.ninja', name: 'Netflix', type: 'app' }],
        onInputSwitched,
      });
      const manager = new InputSourceManager(deps);
      manager.configureInputSources(createMockService() as never);

      const netflix = manager.getSources().find(s => s.id === 'com.netflix.ninja')!;
      await manager.handleSetInput(netflix.identifier);

      expect(onInputSwitched).toHaveBeenCalledWith('com.netflix.ninja');
    });
  });

  // ==========================================================================
  // WHEEL BURST COALESCING (issue #14 — rapid selections)
  // ==========================================================================

  describe('wheel burst coalescing', () => {
    it('only launches the newest selection when several arrive at once', async () => {
      const deps = createMockDeps({
        userInputs: [
          { identifier: 'com.netflix.ninja', name: 'Netflix', type: 'app' },
          { identifier: 'com.disney.disneyplus', name: 'Disney+', type: 'app' },
          { identifier: 'com.hbo.max', name: 'HBO Max', type: 'app' },
        ],
      });
      const manager = new InputSourceManager(deps);
      const tvService = createMockService();
      manager.configureInputSources(tvService as never);
      const ids = ['com.netflix.ninja', 'com.disney.disneyplus', 'com.hbo.max']
        .map(id => manager.getSources().find(s => s.id === id)!.identifier);

      // A burst of wheel moves in the same tick — only the final choice may launch.
      const results = await Promise.all(ids.map(id => manager.handleSetInput(id)));

      expect(results).toHaveLength(3); // superseded selections resolve, not reject
      const launch = deps.tvClient.launchApplication as ReturnType<typeof vi.fn>;
      expect(launch).toHaveBeenCalledTimes(1);
      expect(launch).toHaveBeenCalledWith('com.hbo.max', undefined, undefined);
      expect(manager.currentId).toBe(ids[2]);
    });

    it('launches selections one at a time when they arrive spaced out', async () => {
      const deps = createMockDeps({
        userInputs: [
          { identifier: 'com.netflix.ninja', name: 'Netflix', type: 'app' },
          { identifier: 'com.disney.disneyplus', name: 'Disney+', type: 'app' },
        ],
      });
      const manager = new InputSourceManager(deps);
      manager.configureInputSources(createMockService() as never);
      const netflix = manager.getSources().find(s => s.id === 'com.netflix.ninja')!;
      const disney = manager.getSources().find(s => s.id === 'com.disney.disneyplus')!;

      await manager.handleSetInput(netflix.identifier);
      await manager.handleSetInput(disney.identifier);

      const launch = deps.tvClient.launchApplication as ReturnType<typeof vi.fn>;
      expect(launch).toHaveBeenCalledTimes(2);
      expect(manager.currentId).toBe(disney.identifier);
    });
  });

  // ==========================================================================
  // SYSTEM PACKAGE ALIASES (issue #14 — wake-from-standby alignment)
  // ==========================================================================

  describe('system package aliases in updateFromPoll', () => {
    function managerWithApp() {
      const deps = createMockDeps({
        userInputs: [{ identifier: 'com.netflix.ninja', name: 'Netflix', type: 'app' }],
      });
      const manager = new InputSourceManager(deps);
      const tvService = createMockService();
      manager.configureInputSources(tvService as never);
      return { manager, tvService };
    }

    it('maps the Android launcher to the Home input', () => {
      const { manager, tvService } = managerWithApp();
      const home = manager.getSources().find(s => s.name === 'Home')!;

      const accepted = manager.updateFromPoll('com.google.android.tvlauncher', tvService as never);

      expect(accepted).toBe(home.id);
      expect(manager.currentId).toBe(home.identifier);
    });

    it('maps playtv to Watch TV when the current input is an app', () => {
      const { manager, tvService } = managerWithApp();
      manager.updateFromPoll('com.netflix.ninja', tvService as never);
      const watchTV = manager.getSources().find(s => s.name === 'Watch TV')!;

      const accepted = manager.updateFromPoll('org.droidtv.playtv', tvService as never);

      expect(accepted).toBe(watchTV.id);
      expect(manager.currentId).toBe(watchTV.identifier);
    });

    it('keeps the current HDMI input when playtv is reported', () => {
      const { manager, tvService } = managerWithApp();
      const hdmi3 = manager.getSources().find(s => s.name === 'HDMI 3')!;
      manager.updateFromPoll(hdmi3.id, tvService as never);

      const accepted = manager.updateFromPoll('org.droidtv.playtv', tvService as never);

      expect(accepted).toBe(hdmi3.id);
      expect(manager.currentId).toBe(hdmi3.identifier);
    });

    it('returns the accepted id and null for unknown or suppressed reports', async () => {
      const { manager, tvService } = managerWithApp();

      expect(manager.updateFromPoll('com.netflix.ninja', tvService as never)).toBe('com.netflix.ninja');
      expect(manager.updateFromPoll('com.unknown.app', tvService as never)).toBeNull();
      expect(manager.updateFromPoll(null, tvService as never)).toBeNull();

      // While a manual switch is pending, a contradicting report is suppressed.
      const watchTV = manager.getSources().find(s => s.name === 'Watch TV')!;
      await manager.handleSetInput(watchTV.identifier);
      expect(manager.updateFromPoll('com.netflix.ninja', tvService as never)).toBeNull();
    });
  });
});
