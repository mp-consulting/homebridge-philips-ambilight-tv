import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { PhilipsAmbilightTVAccessory } from './platformAccessory.js';
import type { TVDeviceConfig } from './api/types.js';
import { sanitizeForHomeKit } from './api/utils.js';
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
   * Called when Homebridge restores cached accessories from disk at startup.
   * TV accessories are published as external accessories (own HAP server),
   * so we unregister any stale cached platform accessories here.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Removing stale cached accessory:', accessory.displayName);
    // Defer unregister to after Homebridge finishes restoring all accessories
    this.api.on('didFinishLaunching', () => {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    });
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

    for (let i = 0; i < devices.length; i++) {
      const tv = devices[i];
      if (!this.validateDeviceConfig(tv, i)) {
        continue;
      }

      const displayName = sanitizeForHomeKit(tv.name);
      const uuid = this.api.hap.uuid.generate(PLATFORM_NAME + '-' + tv.mac);

      // Always create fresh and publish as external accessory (own HAP server).
      // Pairing is preserved across restarts via the persist/ directory.
      this.log.info('Publishing external accessory:', displayName);
      const accessory = new this.api.platformAccessory(displayName, uuid, this.api.hap.Categories.TELEVISION);
      accessory.context.device = tv;
      new PhilipsAmbilightTVAccessory(this, accessory);
      this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
    }
  }
}