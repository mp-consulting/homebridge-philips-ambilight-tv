import { describe, it, expect, vi, afterEach } from 'vitest';
import { AmbilightHueSwitchService } from '../../src/services/AmbilightHueSwitchService.js';
import type { AmbilightHueSwitchDeps } from '../../src/services/AmbilightHueSwitchService.js';

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

  return service;
}

function createMockDeps(overrides: Partial<AmbilightHueSwitchDeps['tvClient']> = {}): AmbilightHueSwitchDeps {
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
      getAmbilightHue: vi.fn().mockResolvedValue(false),
      setAmbilightHue: vi.fn().mockResolvedValue(true),
      ...overrides,
    } as never,
    communicationError: () => new Error('comm error') as never,
    log: vi.fn(),
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

function getOnHandlers(accessory: ReturnType<typeof createMockAccessory>) {
  const sw = accessory.services.find(s => s.subtype === 'ambilight-hue-switch')!;
  const onChar = sw.getCharacteristic({ UUID: 'on' });
  return {
    sw,
    onGet: onChar.onGet.mock.calls[0][0] as () => Promise<unknown>,
    onSet: onChar.onSet.mock.calls[0][0] as (v: unknown) => Promise<void>,
  };
}

// ============================================================================
// TEST SUITE
// ============================================================================

describe('AmbilightHueSwitchService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('configureSwitch', () => {
    it('should create a single Switch service', () => {
      const service = new AmbilightHueSwitchService(createMockDeps());
      const accessory = createMockAccessory();

      service.configureSwitch(accessory as never, 'TV');

      expect(accessory.addService).toHaveBeenCalledTimes(1);
      expect(accessory.addService).toHaveBeenCalledWith(expect.anything(), 'TV Ambilight + Hue', 'ambilight-hue-switch');
    });

    it('should reuse an existing switch service', () => {
      const service = new AmbilightHueSwitchService(createMockDeps());
      const accessory = createMockAccessory();
      const existing = createMockService('ambilight-hue-switch');
      accessory.getServiceById = vi.fn().mockReturnValue(existing);

      service.configureSwitch(accessory as never, 'TV');

      expect(accessory.addService).not.toHaveBeenCalled();
    });
  });

  describe('removeSwitch', () => {
    it('should remove the switch when it exists', () => {
      const service = new AmbilightHueSwitchService(createMockDeps());
      const accessory = createMockAccessory();
      const existing = createMockService('ambilight-hue-switch');
      accessory.getServiceById = vi.fn().mockReturnValue(existing);

      service.removeSwitch(accessory as never);

      expect(accessory.removeService).toHaveBeenCalledWith(existing);
    });

    it('should be a no-op when the switch does not exist', () => {
      const service = new AmbilightHueSwitchService(createMockDeps());
      const accessory = createMockAccessory();

      service.removeSwitch(accessory as never);

      expect(accessory.removeService).not.toHaveBeenCalled();
    });
  });

  describe('switch handlers', () => {
    it('should report the live state from the TV on get', async () => {
      const deps = createMockDeps({ getAmbilightHue: vi.fn().mockResolvedValue(true) });
      const service = new AmbilightHueSwitchService(deps);
      const accessory = createMockAccessory();
      service.configureSwitch(accessory as never, 'TV');

      const { onGet } = getOnHandlers(accessory);
      expect(await onGet()).toBe(true);
      expect(deps.tvClient.getAmbilightHue).toHaveBeenCalled();
    });

    it('should fall back to the last known state when the TV is unreachable', async () => {
      const deps = createMockDeps({ getAmbilightHue: vi.fn().mockRejectedValue(new Error('offline')) });
      const service = new AmbilightHueSwitchService(deps);
      const accessory = createMockAccessory();
      service.configureSwitch(accessory as never, 'TV');

      const { onGet } = getOnHandlers(accessory);
      expect(await onGet()).toBe(false);
    });

    it('should enable Ambilight + Hue when turned on', async () => {
      const deps = createMockDeps();
      const service = new AmbilightHueSwitchService(deps);
      const accessory = createMockAccessory();
      service.configureSwitch(accessory as never, 'TV');

      const { onSet } = getOnHandlers(accessory);
      await onSet(true);

      expect(deps.tvClient.setAmbilightHue).toHaveBeenCalledWith(true);
    });

    it('should disable Ambilight + Hue when turned off', async () => {
      const deps = createMockDeps();
      const service = new AmbilightHueSwitchService(deps);
      const accessory = createMockAccessory();
      service.configureSwitch(accessory as never, 'TV');

      const { onSet } = getOnHandlers(accessory);
      await onSet(false);

      expect(deps.tvClient.setAmbilightHue).toHaveBeenCalledWith(false);
    });

    it('should throw a communication error when the write fails', async () => {
      const deps = createMockDeps({ setAmbilightHue: vi.fn().mockResolvedValue(false) });
      const service = new AmbilightHueSwitchService(deps);
      const accessory = createMockAccessory();
      service.configureSwitch(accessory as never, 'TV');

      const { onSet } = getOnHandlers(accessory);
      await expect(onSet(true)).rejects.toThrow('comm error');
    });
  });

  describe('reset', () => {
    it('should force the switch off', async () => {
      const deps = createMockDeps({ getAmbilightHue: vi.fn().mockResolvedValue(true) });
      const service = new AmbilightHueSwitchService(deps);
      const accessory = createMockAccessory();
      service.configureSwitch(accessory as never, 'TV');

      const { sw, onSet } = getOnHandlers(accessory);
      await onSet(true);
      sw.updateCharacteristic.mockClear();

      service.reset();

      expect(sw.updateCharacteristic).toHaveBeenCalledWith({ UUID: 'on' }, false);
    });
  });
});
