import { describe, it, expect, vi } from 'vitest';
import { StateSensorService } from '../../src/services/StateSensorService.js';

// ============================================================================
// MOCK HELPERS
// ============================================================================

const Characteristic = {
  Name: { UUID: 'name' },
  ConfiguredName: { UUID: 'configured-name' },
  MotionDetected: { UUID: 'motion' },
};

const Service = { MotionSensor: { UUID: 'motion-sensor' } };

function createMockService(subtype: string) {
  const values = new Map<unknown, unknown>();
  return {
    UUID: Service.MotionSensor.UUID,
    subtype,
    setCharacteristic: vi.fn().mockImplementation(function (this: unknown, char: unknown, value: unknown) {
      values.set(char, value);
      return this;
    }),
    updateCharacteristic: vi.fn().mockImplementation((char: unknown, value: unknown) => {
      values.set(char, value);
    }),
    addOptionalCharacteristic: vi.fn(),
    getCharacteristic: vi.fn().mockImplementation((char: unknown) => ({ value: values.get(char) })),
  };
}

function createMockAccessory(existing: string[] = []) {
  const services = existing.map(createMockService);
  return {
    services,
    getServiceById: vi.fn().mockImplementation((_svc: unknown, subtype: string) => services.find(s => s.subtype === subtype)),
    addService: vi.fn().mockImplementation((_svc: unknown, _name: string, subtype: string) => {
      const service = createMockService(subtype);
      services.push(service);
      return service;
    }),
    removeService: vi.fn().mockImplementation((service: ReturnType<typeof createMockService>) => {
      services.splice(services.indexOf(service), 1);
    }),
  };
}

function createSensorService() {
  const log = vi.fn();
  const service = new StateSensorService({ Service: Service as never, Characteristic: Characteristic as never, log });
  return { service, log };
}

// ============================================================================
// TESTS
// ============================================================================

describe('StateSensorService', () => {
  it('creates a named sensor for each configured state', () => {
    const { service } = createSensorService();
    const accessory = createMockAccessory();

    service.configureSensors(accessory as never, ['power', 'mute'], 'Living Room');

    expect(accessory.addService).toHaveBeenCalledWith(Service.MotionSensor, 'Living Room Power', 'state-sensor-power');
    expect(accessory.addService).toHaveBeenCalledWith(Service.MotionSensor, 'Living Room Muted', 'state-sensor-mute');
    const power = accessory.services.find(s => s.subtype === 'state-sensor-power')!;
    expect(power.setCharacteristic).toHaveBeenCalledWith(Characteristic.MotionDetected, false);
  });

  it('reuses existing sensors and removes ones no longer configured', () => {
    const { service } = createSensorService();
    const accessory = createMockAccessory(['state-sensor-power', 'state-sensor-ambilight']);

    service.configureSensors(accessory as never, ['power'], 'TV');

    expect(accessory.addService).not.toHaveBeenCalled();
    expect(accessory.services.map(s => s.subtype)).toEqual(['state-sensor-power']);
  });

  it('updates a sensor only when its state changes', () => {
    const { service, log } = createSensorService();
    const accessory = createMockAccessory();
    service.configureSensors(accessory as never, ['ambilight'], 'TV');
    const sensor = accessory.services[0];

    service.update('ambilight', true);
    service.update('ambilight', true);
    service.update('ambilight', false);

    expect(sensor.updateCharacteristic.mock.calls).toEqual([
      [Characteristic.MotionDetected, true],
      [Characteristic.MotionDetected, false],
    ]);
    expect(log).toHaveBeenCalledWith('debug', 'State sensor "ambilight": active');
  });

  it('ignores updates for sensors that are not configured', () => {
    const { service } = createSensorService();
    expect(() => service.update('mute', true)).not.toThrow();
  });
});
