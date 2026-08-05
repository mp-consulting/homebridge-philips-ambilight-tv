import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InputSourceManager } from '../../src/services/InputSourceManager.js';
import type { InputSourceManagerDeps } from '../../src/services/InputSourceManager.js';
import { HOME_URI, WATCH_TV_URI } from '../../src/api/PhilipsTVClient.js';

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
      // "No trackable app" — inconclusive, so a confirmation check accepts it.
      getCurrentActivity: vi.fn().mockResolvedValue('NA'),
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

  // ==========================================================================
  // IDENTIFIERS
  //
  // The Television service advertises a current input by identifier, so every
  // identifier it can name has to belong to an input source that exists. These
  // pin down the reserved low range that guarantees it.
  // ==========================================================================

  describe('identifier allocation', () => {
    it('gives the static sources the reserved identifiers 1-6, in registration order', () => {
      const deps = createMockDeps();
      const manager = new InputSourceManager(deps);
      manager.configureInputSources(createMockService() as never);

      const byId = new Map(manager.getSources().map(s => [s.id, s.identifier]));
      expect(byId.get(WATCH_TV_URI)).toBe(1);
      expect(byId.get(HOME_URI)).toBe(2);
      // HDMI 1-4 take 3-6, leaving nothing in the range unclaimed.
      expect([...byId.values()].filter(i => i >= 1 && i <= 6).length).toBe(6);
    });

    it('numbers apps above the reserved range', () => {
      const deps = createMockDeps({
        customApps: [{ name: 'EON', packageName: 'com.ug.eon.android.tv' }],
      });
      const manager = new InputSourceManager(deps);
      manager.configureInputSources(createMockService() as never);

      const eon = manager.getSources().find(s => s.id === 'com.ug.eon.android.tv')!;
      expect(eon.identifier).toBeGreaterThan(6);
    });

    it('keeps the identifiers an existing install already recorded', () => {
      // Installs predating the reservation numbered their static sources from 7
      // upwards. Renumbering them would move every input HomeKit has a rename
      // or a visibility setting against, so the cache still wins.
      mockReadFileSync.mockReturnValueOnce(JSON.stringify([
        { id: WATCH_TV_URI, name: 'Watch TV', configuredName: 'Watch TV', type: 'source', identifier: 7, visibility: 0 },
        { id: HOME_URI, name: 'Home', configuredName: 'Home', type: 'source', identifier: 8, visibility: 0 },
      ]));

      const deps = createMockDeps();
      const manager = new InputSourceManager(deps);
      manager.configureInputSources(createMockService() as never);

      const byId = new Map(manager.getSources().map(s => [s.id, s.identifier]));
      expect(byId.get(WATCH_TV_URI)).toBe(7);
      expect(byId.get(HOME_URI)).toBe(8);
    });

    it('seeds ActiveIdentifier with an input that exists', () => {
      const deps = createMockDeps();
      const manager = new InputSourceManager(deps);
      const tvService = createMockService();
      manager.configureInputSources(tvService as never);

      const seeded = tvService.updateCharacteristic.mock.calls
        .filter(([char]) => (char as { UUID?: string })?.UUID === 'active-identifier')
        .pop();
      expect(seeded).toBeDefined();
      expect(manager.getSources().map(s => s.identifier)).toContain(seeded![1]);
    });
  });

  describe('handleGetInput', () => {
    it('should report no input before the sources are configured', () => {
      const deps = createMockDeps();
      const manager = new InputSourceManager(deps);

      expect(manager.handleGetInput()).toBe(0);
    });

    it('should return an identifier that belongs to a real input once configured', () => {
      const deps = createMockDeps();
      const manager = new InputSourceManager(deps);
      const tvService = createMockService();
      manager.configureInputSources(tvService as never);

      const identifiers = manager.getSources().map(s => s.identifier);
      expect(identifiers).toContain(manager.handleGetInput());
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
  // DEFERRED SELECTION WHILE THE TV WAKES (issue #17)
  // ==========================================================================

  describe('selection made while the TV is off or waking', () => {
    const APP = {
      name: 'EON',
      packageName: 'com.ug.eon.android.tv',
      className: 'com.ug.eon.android.tv.MainActivity',
    };

    /** A HomeKit scene writes Active and ActiveIdentifier at the same time. */
    const setup = (overrides: Record<string, unknown> = {}) => {
      const deps = createMockDeps({ customApps: [APP], ...overrides });
      const manager = new InputSourceManager(deps);
      const tvService = createMockService();
      manager.configureInputSources(tvService as never);
      const app = manager.getSources().find(s => s.id === 'com.ug.eon.android.tv')!;
      return { deps, manager, tvService, app };
    };

    it('should park the selection instead of launching into a TV that is off', async () => {
      const { deps, manager, app } = setup({ isPoweredOn: () => false });

      await manager.handleSetInput(app.identifier);

      expect(deps.tvClient.launchApplication).not.toHaveBeenCalled();
      expect(manager.hasPendingWakeSelection()).toBe(true);
    });

    it('should show the parked selection as chosen rather than erroring', async () => {
      const { manager, tvService, app } = setup({ isPoweredOn: () => false });

      // Throwing here would bounce the wheel back and make the scene look broken.
      await expect(manager.handleSetInput(app.identifier)).resolves.toBeUndefined();
      expect(tvService.updateCharacteristic).toHaveBeenCalledWith(
        expect.objectContaining({ UUID: 'active-identifier' }), app.identifier,
      );
    });

    it('should apply the parked selection when the TV wakes', async () => {
      const { deps, manager, app } = setup({ isPoweredOn: () => false });
      await manager.handleSetInput(app.identifier);

      // A replay confirms every launch it makes, so it takes the settle time.
      const replay = manager.replayWakeSelection();
      await vi.advanceTimersByTimeAsync(4000);
      await replay;

      expect(deps.tvClient.launchApplication).toHaveBeenCalledWith(
        'com.ug.eon.android.tv', 'com.ug.eon.android.tv.MainActivity', undefined,
      );
      expect(manager.hasPendingWakeSelection()).toBe(false);
    });

    it('should park a launch the TV rejects while it is still booting', async () => {
      const { deps, manager, app } = setup({ isPoweredOn: () => true, isWaking: () => true });
      const launch = deps.tvClient.launchApplication as ReturnType<typeof vi.fn>;
      launch.mockResolvedValue(false);

      // The power write landed first, so the TV reports on but is not ready.
      await expect(manager.handleSetInput(app.identifier)).resolves.toBeUndefined();

      // The TV already reports on, so the power-on edge has passed and the
      // retry has to come from the park itself.
      launch.mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(5000);
      expect(launch.mock.calls.length).toBeGreaterThan(1);
    });

    it('should still report a failure when the TV is up and refuses the launch', async () => {
      const { deps, manager, app } = setup({ isPoweredOn: () => true, isWaking: () => false });
      (deps.tvClient.launchApplication as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      await expect(manager.handleSetInput(app.identifier)).rejects.toThrow();
      expect(manager.hasPendingWakeSelection()).toBe(false);
    });

    it('should retry a replay that the TV rejects mid-boot', async () => {
      const { deps, manager, app } = setup({ isPoweredOn: () => false });
      await manager.handleSetInput(app.identifier);

      const launch = deps.tvClient.launchApplication as ReturnType<typeof vi.fn>;
      launch.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      // A rejected launch costs the retry gap, the accepted one the settle.
      const replay = manager.replayWakeSelection();
      await vi.advanceTimersByTimeAsync(10_000);
      await replay;

      expect(launch).toHaveBeenCalledTimes(2);
    });

    it('should give up after the retry budget and warn', async () => {
      const { deps, manager, app } = setup({ isPoweredOn: () => false });
      await manager.handleSetInput(app.identifier);
      (deps.tvClient.launchApplication as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const replay = manager.replayWakeSelection();
      await vi.advanceTimersByTimeAsync(20_000);
      await replay;

      expect(deps.log).toHaveBeenCalledWith('warn', expect.stringContaining('Could not switch to'));
      expect(manager.hasPendingWakeSelection()).toBe(false);
    });

    it('should discard a selection parked too long ago', async () => {
      const { deps, manager, app } = setup({ isPoweredOn: () => false });
      await manager.handleSetInput(app.identifier);

      // Longer than WAKE_REPLAY_WINDOW_MS — the user is not still waiting.
      vi.setSystemTime(Date.now() + 120_000);
      await manager.replayWakeSelection();

      expect(deps.tvClient.launchApplication).not.toHaveBeenCalled();
    });

    it('should let a newer selection supersede a parked one', async () => {
      const { deps, manager, app } = setup({ isPoweredOn: () => false });
      const watchTv = manager.getSources().find(s => s.id === WATCH_TV_URI)!;

      await manager.handleSetInput(app.identifier);
      await manager.handleSetInput(watchTv.identifier);
      const replay = manager.replayWakeSelection();
      await vi.advanceTimersByTimeAsync(4000);
      await replay;

      expect(deps.tvClient.launchWatchTV).toHaveBeenCalled();
      expect(deps.tvClient.launchApplication).not.toHaveBeenCalled();
    });

    it('should switch normally when the TV is already on', async () => {
      const { deps, manager, app } = setup({ isPoweredOn: () => true, isWaking: () => false });

      await manager.handleSetInput(app.identifier);

      expect(deps.tvClient.launchApplication).toHaveBeenCalled();
      expect(manager.hasPendingWakeSelection()).toBe(false);
    });

    it('should drop a parked selection once a live switch takes over', async () => {
      // Park while off, then let the TV come up and the user pick something
      // else. The parked choice must not fire later and drag the TV back.
      let powered = false;
      const { deps, manager, app } = setup({ isPoweredOn: () => powered, isWaking: () => false });
      const watchTv = manager.getSources().find(s => s.id === WATCH_TV_URI)!;

      await manager.handleSetInput(app.identifier);
      expect(manager.hasPendingWakeSelection()).toBe(true);

      powered = true;
      await manager.handleSetInput(watchTv.identifier);

      expect(manager.hasPendingWakeSelection()).toBe(false);
      await manager.replayWakeSelection();
      expect(deps.tvClient.launchApplication).not.toHaveBeenCalled();
    });

    it('should abandon a replay already under way when a newer selection lands', async () => {
      let powered = false;
      const { deps, manager, app } = setup({ isPoweredOn: () => powered, isWaking: () => false });
      const watchTv = manager.getSources().find(s => s.id === WATCH_TV_URI)!;
      const launch = deps.tvClient.launchApplication as ReturnType<typeof vi.fn>;

      await manager.handleSetInput(app.identifier);

      // The TV comes up but keeps rejecting the parked app, so the replay is
      // mid-retry when the user picks something else.
      powered = true;
      launch.mockResolvedValue(false);
      const replay = manager.replayWakeSelection();
      await manager.handleSetInput(watchTv.identifier);
      await vi.advanceTimersByTimeAsync(20_000);
      await replay;

      expect(deps.tvClient.launchWatchTV).toHaveBeenCalled();
      expect(deps.log).toHaveBeenCalledWith('debug', expect.stringContaining('superseded'));
    });

    it('should hold a source-switch request and the wheel to one outcome', async () => {
      // A scene writes ActiveIdentifier and a source switch at the same moment.
      // Both go through the same arbiter, so only the later one reaches the TV.
      const { deps, manager, app } = setup({ isPoweredOn: () => true, isWaking: () => false });
      const watchTv = manager.getSources().find(s => s.id === WATCH_TV_URI)!;

      await Promise.all([
        manager.handleSetInput(watchTv.identifier),
        manager.requestSwitchById(app.id),
      ]);

      expect(deps.tvClient.launchApplication).toHaveBeenCalled();
      expect(deps.tvClient.launchWatchTV).not.toHaveBeenCalled();
      expect(manager.currentId).toBe(app.identifier);
    });

    it('should align the source switches with a parked selection', async () => {
      const onInputSwitched = vi.fn();
      const { manager, app } = setup({ isPoweredOn: () => false, onInputSwitched });

      await manager.handleSetInput(app.identifier);

      expect(onInputSwitched).toHaveBeenCalledWith(app.id);
    });

    it('should switch normally when no power hooks are supplied', async () => {
      const { deps, manager, app } = setup();

      await manager.handleSetInput(app.identifier);

      expect(deps.tvClient.launchApplication).toHaveBeenCalled();
    });

    // ========================================================================
    // A BOOTING TV ACCEPTS A LAUNCH AND DROPS IT
    // ========================================================================

    it('should retry a launch the booting TV accepted but ignored', async () => {
      // The TV answers OK from standby and then wakes onto its launcher, so
      // the acknowledgement alone must not be taken as the source being on.
      const { deps, manager, app } = setup({ isPoweredOn: () => true, isWaking: () => true });
      const current = deps.tvClient.getCurrentActivity as ReturnType<typeof vi.fn>;
      current.mockResolvedValue('com.google.android.tvlauncher');

      await manager.handleSetInput(app.identifier);
      await vi.advanceTimersByTimeAsync(30_000);

      expect((deps.tvClient.launchApplication as ReturnType<typeof vi.fn>).mock.calls.length)
        .toBeGreaterThan(1);
    });

    it('should stop retrying once the TV reports the requested app', async () => {
      const { deps, manager, app } = setup({ isPoweredOn: () => true, isWaking: () => true });
      const current = deps.tvClient.getCurrentActivity as ReturnType<typeof vi.fn>;
      current.mockResolvedValue('com.ug.eon.android.tv');

      await manager.handleSetInput(app.identifier);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(deps.tvClient.launchApplication).toHaveBeenCalledTimes(1);
      expect(deps.log).toHaveBeenCalledWith('info', expect.stringContaining('after wake'));
    });

    it('should not second-guess the TV once it is past the wake window', async () => {
      const { deps, manager, app } = setup({ isPoweredOn: () => true, isWaking: () => false });

      await manager.handleSetInput(app.identifier);

      expect(deps.tvClient.launchApplication).toHaveBeenCalledTimes(1);
      expect(deps.tvClient.getCurrentActivity).not.toHaveBeenCalled();
    });

    it('should keep confirming on the attempts that outlast the wake window', async () => {
      // The retries take longer to run through than the window lasts. Gating
      // the check on the window switched it off exactly where it was needed
      // most: a set slow enough to need the last retries is the one still
      // booting, and the tail attempts went back to trusting the OK.
      let waking = true;
      const { deps, manager, app } = setup({ isPoweredOn: () => true, isWaking: () => waking });
      (deps.tvClient.getCurrentActivity as ReturnType<typeof vi.fn>)
        .mockResolvedValue('com.google.android.tvlauncher');

      await manager.handleSetInput(app.identifier);
      // The window lapses partway through the replay.
      await vi.advanceTimersByTimeAsync(6_000);
      waking = false;
      const confirmsSoFar = (deps.tvClient.getCurrentActivity as ReturnType<typeof vi.fn>).mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);

      expect((deps.tvClient.getCurrentActivity as ReturnType<typeof vi.fn>).mock.calls.length)
        .toBeGreaterThan(confirmsSoFar);
      expect(deps.log).toHaveBeenCalledWith('warn', expect.stringContaining('Could not switch to'));
    });

    it('should accept the tuner package as proof an HDMI source was reached', async () => {
      // The TV names the same package for the tuner and every HDMI input, so it
      // cannot tell them apart — but it does rule out the launch having been
      // dropped, which would have left the TV on its launcher.
      const { deps, manager } = setup({ isPoweredOn: () => true, isWaking: () => true });
      const hdmi = manager.getSources().find(s => s.id === WATCH_TV_URI)!;
      (deps.tvClient.getCurrentActivity as ReturnType<typeof vi.fn>)
        .mockResolvedValue('org.droidtv.playtv');

      await manager.handleSetInput(hdmi.identifier);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(deps.tvClient.launchWatchTV).toHaveBeenCalledTimes(1);
      expect(deps.log).toHaveBeenCalledWith('info', expect.stringContaining('after wake'));
    });

    it('should treat the tuner package as a dropped launch when an app was asked for', async () => {
      const { deps, manager, app } = setup({ isPoweredOn: () => true, isWaking: () => true });
      (deps.tvClient.getCurrentActivity as ReturnType<typeof vi.fn>)
        .mockResolvedValue('org.droidtv.playtv');

      await manager.handleSetInput(app.identifier);
      await vi.advanceTimersByTimeAsync(30_000);

      expect((deps.tvClient.launchApplication as ReturnType<typeof vi.fn>).mock.calls.length)
        .toBeGreaterThan(1);
    });

    it('should accept the launcher when Home is what was asked for', async () => {
      const { deps, manager } = setup({ isPoweredOn: () => true, isWaking: () => true });
      const home = manager.getSources().find(s => s.id === HOME_URI)!;
      (deps.tvClient.getCurrentActivity as ReturnType<typeof vi.fn>)
        .mockResolvedValue('com.google.android.tvlauncher');

      await manager.handleSetInput(home.identifier);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(deps.tvClient.launchHome).toHaveBeenCalledTimes(1);
      expect(deps.log).toHaveBeenCalledWith('info', expect.stringContaining('after wake'));
    });

    it('should treat an unreachable TV as a launch that cannot have taken', async () => {
      const { deps, manager, app } = setup({ isPoweredOn: () => true, isWaking: () => true });
      (deps.tvClient.getCurrentActivity as ReturnType<typeof vi.fn>)
        .mockRejectedValue(new Error('not up yet'));

      await manager.handleSetInput(app.identifier);
      await vi.advanceTimersByTimeAsync(30_000);

      expect((deps.tvClient.launchApplication as ReturnType<typeof vi.fn>).mock.calls.length)
        .toBeGreaterThan(1);
    });

    it('should never have two launches outstanding on the TV at once', async () => {
      // A request arriving mid-replay starts a second replay, so both go
      // through the shared queue — otherwise each fires into the TV whenever it
      // pleases and the loser can land last.
      const { deps, manager, app } = setup({ isPoweredOn: () => true, isWaking: () => true });
      const watchTv = manager.getSources().find(s => s.id === WATCH_TV_URI)!;
      (deps.tvClient.getCurrentActivity as ReturnType<typeof vi.fn>)
        .mockResolvedValue('com.google.android.tvlauncher');

      // A launch slow enough that the second request lands squarely inside it,
      // which is the only moment the two can genuinely collide.
      let inFlight = 0;
      let maxInFlight = 0;
      const track = async () => {
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await new Promise(resolve => setTimeout(resolve, 5_000));
        inFlight--;
        return true;
      };
      (deps.tvClient.launchApplication as ReturnType<typeof vi.fn>).mockImplementation(track);
      (deps.tvClient.launchWatchTV as ReturnType<typeof vi.fn>).mockImplementation(track);

      await manager.handleSetInput(app.identifier);
      await vi.advanceTimersByTimeAsync(2_000);
      // Lands while the first replay's launch is still outstanding.
      await manager.handleSetInput(watchTv.identifier);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(maxInFlight).toBe(1);
    });

    // ========================================================================
    // SCENE CONFLICT: SWITCH VS LEFTOVER INPUT
    // ========================================================================

    it('should let a source switch win over an input the same scene carries', async () => {
      // The Home app fills a scene's TV input in from whatever it was when the
      // scene was created, so it routinely contradicts the switch the user
      // actually added. The wheel write arriving second must not undo it.
      const { deps, manager, app } = setup({ isPoweredOn: () => true, isWaking: () => false });
      const watchTv = manager.getSources().find(s => s.id === WATCH_TV_URI)!;

      await manager.requestSwitchById(app.id);
      await manager.handleSetInput(watchTv.identifier);

      expect(deps.tvClient.launchWatchTV).not.toHaveBeenCalled();
      expect(manager.currentId).toBe(app.identifier);
    });

    it('should still honour an input picked a moment after using a switch', async () => {
      const { deps, manager, app } = setup({ isPoweredOn: () => true, isWaking: () => false });
      const watchTv = manager.getSources().find(s => s.id === WATCH_TV_URI)!;

      await manager.requestSwitchById(app.id);
      // Well past the window in which the two count as one scene.
      vi.setSystemTime(Date.now() + 10_000);
      await manager.handleSetInput(watchTv.identifier);

      expect(deps.tvClient.launchWatchTV).toHaveBeenCalled();
      expect(manager.currentId).toBe(watchTv.identifier);
    });

    it('should let a source switch win over an input the scene sent first', async () => {
      // The same scene, with the Home app sending its two writes the other way
      // round. The input used to launch before the switch had been heard from,
      // so the TV ran both and the wheel's switch lit up and went dark again
      // (issue #17) — the outcome has to be the one above either way.
      const onInputSwitched = vi.fn();
      const { deps, manager, app } = setup({
        isPoweredOn: () => true,
        isWaking: () => false,
        hasSourceSwitches: () => true,
        onInputSwitched,
      });
      const watchTv = manager.getSources().find(s => s.id === WATCH_TV_URI)!;

      const wheel = manager.handleSetInput(watchTv.identifier);
      // The two writes reach the plugin as separate HAP events, not in one tick.
      await vi.advanceTimersByTimeAsync(5);
      const fromSwitch = manager.requestSwitchById(app.id);
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.all([wheel, fromSwitch]);

      expect(deps.tvClient.launchWatchTV).not.toHaveBeenCalled();
      expect(manager.currentId).toBe(app.identifier);
      // The wheel's source must never have lit up on its way past.
      expect(onInputSwitched.mock.calls).toEqual([[app.id]]);
    });

    it('should not hold an input back when there are no switches to wait for', async () => {
      // Covered implicitly by every other wheel test — they would hang on fake
      // timers if the wait were unconditional — but only by accident, and a
      // hang says nothing about why. Assert it outright: with no switches
      // configured there is no scene conflict to settle, so the input launches
      // without waiting for anything.
      const { deps, manager } = setup({ isPoweredOn: () => true, isWaking: () => false });
      const watchTv = manager.getSources().find(s => s.id === WATCH_TV_URI)!;

      await manager.handleSetInput(watchTv.identifier);

      expect(deps.tvClient.launchWatchTV).toHaveBeenCalled();
    });

    it('should still launch an input picked on its own when switches exist', async () => {
      // The coalescing wait only defers the launch; with no switch behind it
      // the input still has to be applied.
      const { deps, manager } = setup({
        isPoweredOn: () => true,
        isWaking: () => false,
        hasSourceSwitches: () => true,
      });
      const watchTv = manager.getSources().find(s => s.id === WATCH_TV_URI)!;

      const wheel = manager.handleSetInput(watchTv.identifier);
      await vi.advanceTimersByTimeAsync(1000);
      await wheel;

      expect(deps.tvClient.launchWatchTV).toHaveBeenCalled();
      expect(manager.currentId).toBe(watchTv.identifier);
    });

    it('should not treat an input that agrees with the switch as a conflict', async () => {
      const { deps, manager, app } = setup({ isPoweredOn: () => false });

      await manager.requestSwitchById(app.id);
      await manager.handleSetInput(app.identifier);
      const replay = manager.replayWakeSelection();
      await vi.advanceTimersByTimeAsync(4000);
      await replay;

      expect(deps.tvClient.launchApplication).toHaveBeenCalled();
      expect(manager.currentId).toBe(app.identifier);
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
  // SOURCE SWITCH REQUESTS (issue #17 — switches racing the wheel)
  // ==========================================================================

  describe('requestSwitchById', () => {
    it('should launch the source and take the wheel with it', async () => {
      const deps = createMockDeps({
        userInputs: [{ identifier: 'com.netflix.ninja', name: 'Netflix', type: 'app' }],
      });
      const manager = new InputSourceManager(deps);
      const tvService = createMockService();
      manager.configureInputSources(tvService as never);

      const netflixSource = manager.getSources().find(s => s.id === 'com.netflix.ninja');
      await manager.requestSwitchById('com.netflix.ninja');

      expect(deps.tvClient.launchApplication).toHaveBeenCalledWith('com.netflix.ninja', undefined, undefined);
      expect(manager.currentId).toBe(netflixSource!.identifier);
    });

    it('should reject an unknown source ID', async () => {
      const deps = createMockDeps();
      const manager = new InputSourceManager(deps);
      const tvService = createMockService();
      manager.configureInputSources(tvService as never);

      const initialId = manager.currentId;
      await expect(manager.requestSwitchById('com.unknown.app')).rejects.toThrow();

      expect(manager.currentId).toBe(initialId);
    });

    it('should park a source-switch request made while the TV is off', async () => {
      const deps = createMockDeps({
        userInputs: [{ identifier: 'com.netflix.ninja', name: 'Netflix', type: 'app' }],
        isPoweredOn: () => false,
      });
      const manager = new InputSourceManager(deps);
      const tvService = createMockService();
      manager.configureInputSources(tvService as never);

      await manager.requestSwitchById('com.netflix.ninja');

      expect(deps.tvClient.launchApplication).not.toHaveBeenCalled();
      expect(manager.hasPendingWakeSelection()).toBe(true);
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

    it.each([
      'com.google.android.tvlauncher', // Android TV
      'com.google.android.apps.tv.launcherx', // Google TV
      'org.droidtv.customlauncher', // unlisted variant caught by substring
    ])('maps the launcher %s to the Home input', (launcher) => {
      const { manager, tvService } = managerWithApp();
      const home = manager.getSources().find(s => s.name === 'Home')!;

      const accepted = manager.updateFromPoll(launcher, tvService as never);

      expect(accepted).toBe(home.id);
      expect(manager.currentId).toBe(home.identifier);
    });

    it('maps a sustained NA to Home', () => {
      const { manager, tvService } = managerWithApp();
      manager.updateFromPoll('com.netflix.ninja', tvService as never);
      const home = manager.getSources().find(s => s.name === 'Home')!;

      // First sighting is treated as transitional; the second applies.
      expect(manager.updateFromPoll('NA', tvService as never)).toBeNull();
      expect(manager.updateFromPoll('NA', tvService as never)).toBe(home.id);
      expect(manager.currentId).toBe(home.identifier);
    });

    it('maps a sustained NA to Home even from a source input (Home button on the remote)', () => {
      const { manager, tvService } = managerWithApp();
      const watchTV = manager.getSources().find(s => s.name === 'Watch TV')!;
      const home = manager.getSources().find(s => s.name === 'Home')!;
      manager.updateFromPoll(watchTV.id, tvService as never);

      manager.updateFromPoll('NA', tvService as never);
      const accepted = manager.updateFromPoll('NA', tvService as never);

      expect(accepted).toBe(home.id);
      expect(manager.currentId).toBe(home.identifier);
    });

    it('keeps an app the TV never reports itself when it says there is no trackable app', async () => {
      const { manager, tvService } = managerWithApp();
      const netflix = manager.getSources().find(s => s.id === 'com.netflix.ninja')!;

      // The user picks the app and the TV never names it in a report of its
      // own — for such apps "NA" says nothing about what is on screen.
      await manager.handleSetInput(netflix.identifier);
      vi.advanceTimersByTime(21_000); // past the manual-switch confirmation guard

      expect(manager.updateFromPoll('NA', tvService as never)).toBeNull();
      expect(manager.updateFromPoll('NA', tvService as never)).toBeNull();
      expect(manager.currentId).toBe(netflix.identifier);
    });

    it('lets NA align to Home on wake even when the pre-standby input was an untracked app', async () => {
      const { manager, tvService } = managerWithApp();
      const netflix = manager.getSources().find(s => s.id === 'com.netflix.ninja')!;
      const home = manager.getSources().find(s => s.name === 'Home')!;
      await manager.handleSetInput(netflix.identifier);
      vi.advanceTimersByTime(21_000);

      manager.markAwaitingWakeAlignment();
      manager.updateFromPoll('NA', tvService as never);
      const accepted = manager.updateFromPoll('NA', tvService as never);

      expect(accepted).toBe(home.id);
      expect(manager.currentId).toBe(home.identifier);
    });

    it('applies NA as Home once the TV has reported the current app by name', async () => {
      const { manager, tvService } = managerWithApp();
      const netflix = manager.getSources().find(s => s.id === 'com.netflix.ninja')!;
      const home = manager.getSources().find(s => s.name === 'Home')!;

      await manager.handleSetInput(netflix.identifier);
      vi.advanceTimersByTime(21_000);
      // The TV tracks this app, so leaving it really does show up as NA.
      manager.updateFromPoll('com.netflix.ninja', tvService as never);

      manager.updateFromPoll('NA', tvService as never);
      const accepted = manager.updateFromPoll('NA', tvService as never);

      expect(accepted).toBe(home.id);
      expect(manager.currentId).toBe(home.identifier);
    });

    it('still moves an untracked app to the tuner when the TV reports playtv', async () => {
      const { manager, tvService } = managerWithApp();
      const netflix = manager.getSources().find(s => s.id === 'com.netflix.ninja')!;
      const watchTV = manager.getSources().find(s => s.name === 'Watch TV')!;

      await manager.handleSetInput(netflix.identifier);
      vi.advanceTimersByTime(21_000);

      // playtv names the tuner service — unlike NA it is positive evidence
      // that the TV left the app, so it applies after the usual confirmation.
      manager.updateFromPoll('org.droidtv.playtv', tvService as never);
      const accepted = manager.updateFromPoll('org.droidtv.playtv', tvService as never);

      expect(accepted).toBe(watchTV.id);
      expect(manager.currentId).toBe(watchTV.identifier);
    });

    it('ignores a lone transitional system report between app switches', () => {
      const { manager, tvService } = managerWithApp();
      const netflix = manager.getSources().find(s => s.id === 'com.netflix.ninja')!;
      manager.updateFromPoll('com.netflix.ninja', tvService as never);

      // A single playtv while the TV transitions must not move the state...
      expect(manager.updateFromPoll('org.droidtv.playtv', tvService as never)).toBeNull();
      // ...and the app settling again resets the sighting counter.
      expect(manager.updateFromPoll('com.netflix.ninja', tvService as never)).toBe('com.netflix.ninja');
      expect(manager.updateFromPoll('org.droidtv.playtv', tvService as never)).toBeNull();

      expect(manager.currentId).toBe(netflix.identifier);
    });

    it('never remaps a package the user registered as an input', () => {
      const deps = createMockDeps({
        userInputs: [{ identifier: 'com.custom.launcher', name: 'My Launcher', type: 'app' }],
      });
      const manager = new InputSourceManager(deps);
      const tvService = createMockService();
      manager.configureInputSources(tvService as never);
      const custom = manager.getSources().find(s => s.id === 'com.custom.launcher')!;

      const accepted = manager.updateFromPoll('com.custom.launcher', tvService as never);

      expect(accepted).toBe('com.custom.launcher');
      expect(manager.currentId).toBe(custom.identifier);
    });

    it('maps a sustained playtv to Watch TV when the current input is an app', () => {
      const { manager, tvService } = managerWithApp();
      manager.updateFromPoll('com.netflix.ninja', tvService as never);
      const watchTV = manager.getSources().find(s => s.name === 'Watch TV')!;

      manager.updateFromPoll('org.droidtv.playtv', tvService as never);
      const accepted = manager.updateFromPoll('org.droidtv.playtv', tvService as never);

      expect(accepted).toBe(watchTV.id);
      expect(manager.currentId).toBe(watchTV.identifier);
    });

    it('keeps the current HDMI input when playtv is reported', () => {
      const { manager, tvService } = managerWithApp();
      const hdmi3 = manager.getSources().find(s => s.name === 'HDMI 3')!;
      manager.updateFromPoll(hdmi3.id, tvService as never);

      manager.updateFromPoll('org.droidtv.playtv', tvService as never);
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
