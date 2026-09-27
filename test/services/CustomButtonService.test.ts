import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CustomButtonService, BUTTON_RESET_DELAY_MS } from '../../src/services/CustomButtonService.js';
import type { CustomButtonDeps } from '../../src/services/CustomButtonService.js';
import type { CustomButtonConfig } from '../../src/api/types.js';

// ============================================================================
// MOCKS
// ============================================================================

function createMockService(subtype?: string) {
  const characteristics = new Map<string, { value: unknown; onGet: ReturnType<typeof vi.fn>; onSet: ReturnType<typeof vi.fn> }>();

  return {
    UUID: 'switch-uuid',
    subtype,
    setCharacteristic: vi.fn().mockReturnThis(),
    addOptionalCharacteristic: vi.fn(),
    getCharacteristic: vi.fn().mockImplementation((char: { UUID?: string }) => {
      const key = char?.UUID ?? 'unknown';
      if (!characteristics.has(key)) {
        characteristics.set(key, {
          value: null as unknown,
          onGet: vi.fn().mockReturnThis(),
          onSet: vi.fn().mockReturnThis(),
        });
      }
      return characteristics.get(key)!;
    }),
    updateCharacteristic: vi.fn().mockReturnThis(),
  };
}

type MockService = ReturnType<typeof createMockService>;

function createMockDeps(sendKey = vi.fn().mockResolvedValue(true)): CustomButtonDeps {
  return {
    Service: {
      Switch: { UUID: 'switch-uuid' },
    } as never,
    Characteristic: {
      Name: { UUID: 'name' },
      ConfiguredName: { UUID: 'configured-name' },
      On: { UUID: 'on' },
    } as never,
    tvClient: { sendKey } as never,
    communicationError: () => new Error('comm error') as never,
    log: vi.fn(),
  };
}

function createMockAccessory(existing: MockService[] = []) {
  const services: MockService[] = [...existing];
  return {
    services,
    getServiceById: vi.fn().mockImplementation((_svc: unknown, subtype: string) => services.find(s => s.subtype === subtype) ?? null),
    addService: vi.fn().mockImplementation((_svc: unknown, _name: string, subtype: string) => {
      const service = createMockService(subtype);
      services.push(service);
      return service;
    }),
    removeService: vi.fn().mockImplementation((service: MockService) => {
      services.splice(services.indexOf(service), 1);
    }),
  };
}

function configure(buttons: CustomButtonConfig[], deps = createMockDeps(), accessory = createMockAccessory()) {
  const service = new CustomButtonService(deps);
  service.configureButtons(accessory as never, buttons, 'Living Room TV');
  return { service, deps, accessory };
}

function getOnHandlers(accessory: ReturnType<typeof createMockAccessory>, subtype: string) {
  const sw = accessory.services.find(s => s.subtype === subtype)!;
  const onChar = sw.getCharacteristic({ UUID: 'on' });
  return {
    sw,
    onGet: onChar.onGet.mock.calls[0][0] as () => unknown,
    onSet: onChar.onSet.mock.calls[0][0] as (v: unknown) => Promise<void>,
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('CustomButtonService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('configureButtons', () => {
    it('adds one switch per button, keyed by the remote key', () => {
      const { accessory } = configure([
        { name: 'Power Menu', key: 'Stop' },
        { name: 'Recents', key: 'Record' },
      ]);

      expect(accessory.addService).toHaveBeenCalledTimes(2);
      expect(accessory.addService).toHaveBeenCalledWith(expect.anything(), 'Living Room TV Power Menu', 'custom-button-Stop');
      expect(accessory.addService).toHaveBeenCalledWith(expect.anything(), 'Living Room TV Recents', 'custom-button-Record');
    });

    it('sanitizes the name for HomeKit and falls back to the key', () => {
      const { accessory } = configure([
        { name: 'Menu+', key: 'Stop' },
        { name: '', key: 'Record' },
      ]);

      const stop = accessory.services.find(s => s.subtype === 'custom-button-Stop')!;
      const record = accessory.services.find(s => s.subtype === 'custom-button-Record')!;
      expect(stop.setCharacteristic).toHaveBeenCalledWith({ UUID: 'configured-name' }, 'Menu Plus');
      expect(record.setCharacteristic).toHaveBeenCalledWith({ UUID: 'configured-name' }, 'Record');
    });

    it('skips unknown keys and duplicate keys with a warning', () => {
      const { accessory, deps } = configure([
        { name: 'Bogus', key: 'NotAKey' as never },
        { name: 'First', key: 'Stop' },
        { name: 'Second', key: 'Stop' },
      ]);

      expect(accessory.addService).toHaveBeenCalledTimes(1);
      expect(accessory.addService).toHaveBeenCalledWith(expect.anything(), 'Living Room TV First', 'custom-button-Stop');
      expect(deps.log).toHaveBeenCalledWith('warn', expect.stringContaining('unknown key'));
      expect(deps.log).toHaveBeenCalledWith('warn', expect.stringContaining('already used'));
    });

    it('reuses an existing switch so a rename keeps its HomeKit identity', () => {
      const existing = createMockService('custom-button-Stop');
      const { accessory } = configure([{ name: 'Renamed', key: 'Stop' }], createMockDeps(), createMockAccessory([existing]));

      expect(accessory.addService).not.toHaveBeenCalled();
      expect(existing.setCharacteristic).toHaveBeenCalledWith({ UUID: 'configured-name' }, 'Renamed');
    });

    it('removes switches for buttons no longer configured, leaving other switches alone', () => {
      const stale = createMockService('custom-button-Record');
      const other = createMockService('source-switch-hdmi1');
      const { accessory } = configure([{ name: 'Power Menu', key: 'Stop' }], createMockDeps(), createMockAccessory([stale, other]));

      expect(accessory.removeService).toHaveBeenCalledTimes(1);
      expect(accessory.removeService).toHaveBeenCalledWith(stale);
    });
  });

  describe('pressing a button', () => {
    it('sends its key once and turns itself back off', async () => {
      const { accessory, deps } = configure([{ name: 'Power Menu', key: 'Stop' }]);
      const { sw, onGet, onSet } = getOnHandlers(accessory, 'custom-button-Stop');

      await onSet(true);

      expect(deps.tvClient.sendKey).toHaveBeenCalledTimes(1);
      expect(deps.tvClient.sendKey).toHaveBeenCalledWith('Stop');
      expect(onGet()).toBe(false);

      await vi.advanceTimersByTimeAsync(BUTTON_RESET_DELAY_MS);
      expect(sw.updateCharacteristic).toHaveBeenCalledWith({ UUID: 'on' }, false);
    });

    it('does nothing when turned off', async () => {
      const { accessory, deps } = configure([{ name: 'Power Menu', key: 'Stop' }]);
      const { onSet } = getOnHandlers(accessory, 'custom-button-Stop');

      await onSet(false);

      expect(deps.tvClient.sendKey).not.toHaveBeenCalled();
    });

    it('reports a communication error and still resets when the TV rejects the key', async () => {
      const deps = createMockDeps(vi.fn().mockResolvedValue(false));
      const { accessory } = configure([{ name: 'Power Menu', key: 'Stop' }], deps);
      const { sw, onSet } = getOnHandlers(accessory, 'custom-button-Stop');

      await expect(onSet(true)).rejects.toThrow('comm error');
      expect(deps.log).toHaveBeenCalledWith('warn', 'Custom button: failed to send Stop');

      await vi.advanceTimersByTimeAsync(BUTTON_RESET_DELAY_MS);
      expect(sw.updateCharacteristic).toHaveBeenCalledWith({ UUID: 'on' }, false);
    });

    it('reports a communication error when the TV is unreachable', async () => {
      const deps = createMockDeps(vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
      const { accessory } = configure([{ name: 'Power Menu', key: 'Stop' }], deps);
      const { onSet } = getOnHandlers(accessory, 'custom-button-Stop');

      await expect(onSet(true)).rejects.toThrow('comm error');
    });
  });

  describe('cleanup', () => {
    it('cancels pending resets', async () => {
      const { service, accessory } = configure([{ name: 'Power Menu', key: 'Stop' }]);
      const { sw, onSet } = getOnHandlers(accessory, 'custom-button-Stop');

      await onSet(true);
      service.cleanup();
      await vi.advanceTimersByTimeAsync(BUTTON_RESET_DELAY_MS);

      expect(sw.updateCharacteristic).not.toHaveBeenCalled();
    });
  });
});
