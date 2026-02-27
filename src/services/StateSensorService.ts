import type { Characteristic, PlatformAccessory, Service } from 'homebridge';

// ============================================================================
// TYPES
// ============================================================================

export type StateSensorType = 'power' | 'ambilight' | 'mute';

export interface StateSensorDeps {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const SENSOR_LABELS: Record<StateSensorType, string> = {
  power: 'Power',
  ambilight: 'Ambilight',
  mute: 'Muted',
};

// ============================================================================
// STATE SENSOR SERVICE
// ============================================================================

/**
 * Manages MotionSensor services that expose TV states to HomeKit.
 * Each sensor triggers "motion detected" when the state is active,
 * enabling HomeKit automations (e.g., "when TV turns on, dim lights").
 */
export class StateSensorService {
  private sensors = new Map<StateSensorType, Service>();

  constructor(private readonly deps: StateSensorDeps) {}

  // ==========================================================================
  // CONFIGURATION
  // ==========================================================================

  configureSensors(
    accessory: PlatformAccessory,
    sensorTypes: StateSensorType[],
    tvName: string,
  ): void {
    const { Service: Svc, Characteristic: Char } = this.deps;

    // Remove stale sensor services that are no longer configured
    const validSubtypes = new Set(sensorTypes.map(t => `state-sensor-${t}`));
    accessory.services
      .filter(s => s.UUID === Svc.MotionSensor.UUID && s.subtype?.startsWith('state-sensor-'))
      .forEach(s => {
        if (!validSubtypes.has(s.subtype!)) {
          accessory.removeService(s);
        }
      });

    for (const type of sensorTypes) {
      const subtype = `state-sensor-${type}`;
      const displayName = `${tvName} ${SENSOR_LABELS[type]}`;

      let service = accessory.getServiceById(Svc.MotionSensor, subtype);
      if (!service) {
        service = accessory.addService(Svc.MotionSensor, displayName, subtype);
      }

      service.setCharacteristic(Char.Name, displayName);
      service.setCharacteristic(Char.MotionDetected, false);
      this.sensors.set(type, service);
    }

    if (sensorTypes.length > 0) {
      this.deps.log('info', `Configured ${sensorTypes.length} state sensor(s): ${sensorTypes.join(', ')}`);
    }
  }

  // ==========================================================================
  // STATE UPDATES
  // ==========================================================================

  update(type: StateSensorType, active: boolean): void {
    const service = this.sensors.get(type);
    if (!service) {
      return;
    }

    const current = service.getCharacteristic(this.deps.Characteristic.MotionDetected).value;
    if (current !== active) {
      service.updateCharacteristic(this.deps.Characteristic.MotionDetected, active);
      this.deps.log('debug', `State sensor "${type}": ${active ? 'active' : 'inactive'}`);
    }
  }

  resetAll(): void {
    for (const [, service] of this.sensors) {
      service.updateCharacteristic(this.deps.Characteristic.MotionDetected, false);
    }
  }
}
