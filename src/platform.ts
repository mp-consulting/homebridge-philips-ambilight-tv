import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { PhilipsAmbilightTVAccessory } from './platformAccessory.js';
import type { TVDeviceConfig } from './api/types.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

// ============================================================================
// VALIDATION
// ============================================================================

const IPV4_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const MAC_REGEX = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;
const MIN_POLLING_INTERVAL_MS = 1000;
const MAX_POLLING_INTERVAL_MS = 60000;

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class PhilipsAmbilightTVPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: Map<string, PlatformAccessory> = new Map();

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.debug('Finished initializing platform:', this.config.platform);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      this.log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to set up event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private validateDeviceConfig(device: any, index: number): device is TVDeviceConfig {
    const requiredFields = ['name', 'ip', 'mac', 'username', 'password'] as const;

    for (const field of requiredFields) {
      if (!device[field] || typeof device[field] !== 'string') {
        this.log.error(`Device #${index + 1}: Missing or invalid required field "${field}". Skipping.`);
        return false;
      }
    }

    if (!IPV4_REGEX.test(device.ip as string)) {
      this.log.error(`Device "${device.name}": Invalid IP address format "${device.ip}". Skipping.`);
      return false;
    }

    if (!MAC_REGEX.test(device.mac as string)) {
      this.log.error(`Device "${device.name}": Invalid MAC address format "${device.mac}". Skipping.`);
      return false;
    }

    if (device.pollingInterval !== undefined) {
      const interval = device.pollingInterval as number;
      if (typeof interval !== 'number' || interval < MIN_POLLING_INTERVAL_MS || interval > MAX_POLLING_INTERVAL_MS) {
        this.log.warn(
          `Device "${device.name}": pollingInterval ${interval}ms is out of range ` +
          `(${MIN_POLLING_INTERVAL_MS}-${MAX_POLLING_INTERVAL_MS}). Using default.`,
        );
        delete device.pollingInterval;
      }
    }

    return true;
  }

  discoverDevices() {
    const devices = this.config.devices || [];

    if (!devices.length) {
      this.log.warn('No devices configured');
    }

    // Track which UUIDs are still in the config
    const configuredUUIDs = new Set<string>();

    for (let i = 0; i < devices.length; i++) {
      const tv = devices[i];
      if (!this.validateDeviceConfig(tv, i)) {
        continue;
      }

      const uuid = this.api.hap.uuid.generate(PLATFORM_NAME + '-' + tv.mac);
      configuredUUIDs.add(uuid);

      const existingAccessory = this.accessories.get(uuid);

      if (existingAccessory) {
        // Accessory already exists, update context and re-initialize
        this.log.info('Restoring existing accessory from cache:', tv.name);
        existingAccessory.context.device = tv;
        new PhilipsAmbilightTVAccessory(this, existingAccessory);
      } else {
        // Create new accessory
        this.log.info('Adding new accessory:', tv.name);
        const accessory = new this.api.platformAccessory(tv.name, uuid, this.api.hap.Categories.TELEVISION);
        accessory.context.device = tv;
        new PhilipsAmbilightTVAccessory(this, accessory);
        this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
      }
    }

    // Remove accessories that are no longer in the config
    for (const [uuid, accessory] of this.accessories) {
      if (!configuredUUIDs.has(uuid)) {
        this.log.info('Removing accessory no longer in config:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
      }
    }
  }
}