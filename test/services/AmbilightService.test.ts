import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AmbilightService } from '../../src/services/AmbilightService.js';
import type { AmbilightServiceDeps } from '../../src/services/AmbilightService.js';

// ============================================================================
// MOCK HELPERS
// ============================================================================

function createMockCharacteristic() {
  let value: unknown = null;
  const char = {
    get value() {
      return value;
    },
    onGet: vi.fn().mockImplementation((fn: () => unknown) => {
      char._getter = fn;
      return char;
    }),
    onSet: vi.fn().mockImplementation((fn: (v: unknown) => void) => {
      char._setter = fn;
      return char;
    }),
    updateValue: vi.fn().mockImplementation((v: unknown) => {
      value = v;
      return char;
    }),
    setProps: vi.fn().mockReturnThis(),
    _getter: undefined as (() => unknown) | undefined,
    _setter: undefined as ((v: unknown) => void) | undefined,
  };
  return char;
}

function createMockService() {
  const characteristics = new Map<string, ReturnType<typeof createMockCharacteristic>>();

  return {
    setCharacteristic: vi.fn().mockReturnThis(),
    getCharacteristic: vi.fn().mockImplementation((charType: { UUID?: string }) => {
      const key = charType?.UUID ?? 'unknown';
      if (!characteristics.has(key)) {
        characteristics.set(key, createMockCharacteristic());
      }
      return characteristics.get(key)!;
    }),
    updateCharacteristic: vi.fn().mockReturnThis(),
    addLinkedService: vi.fn(),
    _characteristics: characteristics,
  };
}

function createMockDeps(overrides?: Partial<AmbilightServiceDeps>): AmbilightServiceDeps {
  const lightbulbService = createMockService();

  return {
    Service: {
      Lightbulb: { UUID: 'lightbulb' },
    } as never,
    Characteristic: {
      Name: { UUID: 'name' },
      On: { UUID: 'on' },
      Brightness: { UUID: 'brightness' },
      Hue: { UUID: 'hue' },
      Saturation: { UUID: 'saturation' },
      ColorTemperature: { UUID: 'color-temp' },
    } as never,
    AdaptiveLightingController: class {} as never,
    ColorUtils: {
      colorTemperatureToHueAndSaturation: vi.fn().mockReturnValue({ hue: 30, saturation: 60 }),
    } as never,
    tvClient: {
      setAmbilightPower: vi.fn().mockResolvedValue(true),
      setAmbilightStyle: vi.fn().mockResolvedValue(true),
      setAmbilightOff: vi.fn().mockResolvedValue(true),
      setAmbilightFollowColor: vi.fn().mockResolvedValue(true),
      getAmbilightStyle: vi.fn().mockResolvedValue(null),
    } as never,
    accessory: {
      getService: vi.fn().mockReturnValue(lightbulbService),
      addService: vi.fn().mockReturnValue(lightbulbService),
      configureController: vi.fn(),
    } as never,
    communicationError: () => new Error('comm error') as never,
    log: vi.fn(),
    ...overrides,
  };
}

// ============================================================================
// COLOR CONVERSION TESTS
// ============================================================================

describe('AmbilightService color conversion', () => {
  const service = new AmbilightService({
    Service: {} as never,
    Characteristic: {} as never,
    AdaptiveLightingController: vi.fn() as never,
    ColorUtils: {} as never,
    tvClient: {} as never,
    accessory: {} as never,
    communicationError: () => new Error('test') as never,
    log: () => {},
  });

  describe('homekitToPhilipsColor', () => {
    it('should convert max HomeKit values to max Philips values', () => {
      const result = service.homekitToPhilipsColor(360, 100, 100);
      expect(result).toEqual({ hue: 255, saturation: 255, brightness: 255 });
    });

    it('should convert zero values', () => {
      const result = service.homekitToPhilipsColor(0, 0, 0);
      expect(result).toEqual({ hue: 0, saturation: 0, brightness: 0 });
    });

    it('should convert mid-range values', () => {
      const result = service.homekitToPhilipsColor(180, 50, 50);
      expect(result).toEqual({ hue: 128, saturation: 128, brightness: 128 });
    });

    it('should round correctly', () => {
      // 90/360 * 255 = 63.75 -> 64
      const result = service.homekitToPhilipsColor(90, 25, 75);
      expect(result.hue).toBe(64);
      expect(result.saturation).toBe(64);
      expect(result.brightness).toBe(191);
    });

    it('should clamp values exceeding max range', () => {
      // Out-of-range values should be clamped to 255
      const result = service.homekitToPhilipsColor(400, 120, 110);
      expect(result.hue).toBeLessThanOrEqual(255);
      expect(result.saturation).toBeLessThanOrEqual(255);
      expect(result.brightness).toBeLessThanOrEqual(255);
    });
  });

  describe('philipsToHomekitColor', () => {
    it('should convert max Philips values to max HomeKit values', () => {
      const result = service.philipsToHomekitColor({ hue: 255, saturation: 255, brightness: 255 });
      expect(result).toEqual({ hue: 360, saturation: 100, brightness: 100 });
    });

    it('should convert zero values', () => {
      const result = service.philipsToHomekitColor({ hue: 0, saturation: 0, brightness: 0 });
      expect(result).toEqual({ hue: 0, saturation: 0, brightness: 0 });
    });

    it('should be roughly inverse of homekitToPhilipsColor', () => {
      const original = { hue: 200, saturation: 75, brightness: 50 };
      const philips = service.homekitToPhilipsColor(original.hue, original.saturation, original.brightness);
      const roundTrip = service.philipsToHomekitColor(philips);

      // Allow +-1 for rounding
      expect(Math.abs(roundTrip.hue - original.hue)).toBeLessThanOrEqual(2);
      expect(Math.abs(roundTrip.saturation - original.saturation)).toBeLessThanOrEqual(1);
      expect(Math.abs(roundTrip.brightness - original.brightness)).toBeLessThanOrEqual(1);
    });

    it('should clamp values exceeding max range', () => {
      const result = service.philipsToHomekitColor({ hue: 300, saturation: 300, brightness: 300 });
      expect(result.hue).toBeLessThanOrEqual(360);
      expect(result.saturation).toBeLessThanOrEqual(100);
      expect(result.brightness).toBeLessThanOrEqual(100);
    });
  });
});

// ============================================================================
// SERVICE CONFIGURATION
// ============================================================================

describe('AmbilightService configureService', () => {
  it('should set up all characteristics', () => {
    const deps = createMockDeps();
    const service = new AmbilightService(deps);

    const tvService = createMockService();
    const result = service.configureService(deps.accessory as never, tvService as never);

    expect(result).toBeDefined();
    expect(tvService.addLinkedService).toHaveBeenCalled();
  });

  it('should configure adaptive lighting controller', () => {
    const deps = createMockDeps();
    const service = new AmbilightService(deps);

    const tvService = createMockService();
    service.configureService(deps.accessory as never, tvService as never);

    expect((deps.accessory as { configureController: ReturnType<typeof vi.fn> }).configureController).toHaveBeenCalled();
  });
});

// ============================================================================
// POLL UPDATES
// ============================================================================

describe('AmbilightService updateFromPoll', () => {
  let deps: AmbilightServiceDeps;
  let ambilightService: AmbilightService;

  beforeEach(() => {
    vi.useFakeTimers();
    deps = createMockDeps();
    ambilightService = new AmbilightService(deps);
    const tvService = createMockService();
    ambilightService.configureService(deps.accessory as never, tvService as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should update on/off state from poll', () => {
    ambilightService.updateFromPoll({ styleName: 'FOLLOW_VIDEO', algorithm: 'NATURAL' }, false);
    expect(ambilightService.isAmbilightOn).toBe(true);
  });

  it('should detect OFF style as off', () => {
    ambilightService.updateFromPoll({ styleName: 'OFF' }, false);
    expect(ambilightService.isAmbilightOn).toBe(false);
  });

  it('should use power fallback when style is null', () => {
    ambilightService.updateFromPoll(null, true);
    expect(ambilightService.isAmbilightOn).toBe(true);
  });

  it('should update color from FOLLOW_COLOR style', () => {
    const style = {
      styleName: 'FOLLOW_COLOR',
      algorithm: 'MANUAL_HUE',
      colorSettings: {
        color: { hue: 128, saturation: 200, brightness: 255 },
      },
    };

    ambilightService.updateFromPoll(style, false);
    expect(ambilightService.isAmbilightOn).toBe(true);
  });

  it('should skip poll updates during user action cooldown', async () => {
    // Trigger the "on" handler to set lastUserAction
    const service = ambilightService.getService();
    const onChar = service.getCharacteristic((deps.Characteristic as { On: unknown }).On);
    if (onChar._setter) {
      // Start the async handler (won't await it, just set the timestamp)
      try {
        await onChar._setter(true);
      } catch {
        // OK if it fails, we just need the timestamp set
      }
    }

    // Now poll updates should be ignored during cooldown
    ambilightService.updateFromPoll({ styleName: 'OFF' }, false);
    // The ambilight should still be "on" because the poll was ignored
    expect(ambilightService.isAmbilightOn).toBe(true);
  });
});

// ============================================================================
// AMBILIGHT MODE PARSING
// ============================================================================

describe('AmbilightService ambilight mode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should use default mode FOLLOW_VIDEO/NATURAL when none configured', async () => {
    const deps = createMockDeps();
    const service = new AmbilightService(deps);
    const tvService = createMockService();
    service.configureService(deps.accessory as never, tvService as never);

    // Access the handler for On
    const hkService = service.getService();
    const onChar = hkService.getCharacteristic((deps.Characteristic as { On: unknown }).On);

    if (onChar._setter) {
      await onChar._setter(true);
    }

    expect(deps.tvClient.setAmbilightStyle).toHaveBeenCalledWith('FOLLOW_VIDEO', 'NATURAL');
  });

  it('should use custom ambilight mode from config', async () => {
    const deps = createMockDeps({ ambilightMode: 'FOLLOW_AUDIO/ENERGY_ADAPTIVE_BRIGHTNESS' });
    const service = new AmbilightService(deps);
    const tvService = createMockService();
    service.configureService(deps.accessory as never, tvService as never);

    const hkService = service.getService();
    const onChar = hkService.getCharacteristic((deps.Characteristic as { On: unknown }).On);

    if (onChar._setter) {
      await onChar._setter(true);
    }

    expect(deps.tvClient.setAmbilightStyle).toHaveBeenCalledWith('FOLLOW_AUDIO', 'ENERGY_ADAPTIVE_BRIGHTNESS');
  });
});
