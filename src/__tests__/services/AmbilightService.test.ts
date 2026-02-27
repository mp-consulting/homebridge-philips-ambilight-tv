import { describe, it, expect } from 'vitest';
import { AmbilightService } from '../../services/AmbilightService.js';

// ============================================================================
// COLOR CONVERSION TESTS
// ============================================================================

describe('AmbilightService color conversion', () => {
  // Create a minimal instance to test color conversion methods
  const service = new AmbilightService({
    Service: {} as never,
    Characteristic: {} as never,
    tvClient: {} as never,
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
  });
});
