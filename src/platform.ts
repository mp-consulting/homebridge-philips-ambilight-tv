import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { PhilipsAmbilightTVAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

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
  public readonly discoveredCacheUUIDs: string[] = [];

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.debug('Finished initializing platform:', this.config.name);

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

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  discoverDevices() {
    // A real plugin you would discover accessories from the local network, cloud services
    // or a user-defined array in the platform config.
    
    // For now, we'll just use the config to create a single accessory if it doesn't exist
    if (!this.config.ip) {
      this.log.info('No TV IP configured.');
      return;
    }

    const uuid = this.api.hap.uuid.generate('PhilipsAmbilightTV-' + (this.config.mac || this.config.ip));
    this.log.info('Discovering device with UUID:', uuid);
    
    // Check if we have already registered this accessory in this session
    if (this.accessories.has(uuid)) {
      this.log.info('Accessory already registered in this session:', uuid);
      const existingAccessory = this.accessories.get(uuid);
      if (existingAccessory) {
        new PhilipsAmbilightTVAccessory(this, existingAccessory);
      }
      return;
    }

    const existingAccessory = this.accessories.get(uuid);

    if (existingAccessory) {
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
      new PhilipsAmbilightTVAccessory(this, existingAccessory);
    } else {
      this.log.info('Adding new accessory:', this.config.name);
      const accessory = new this.api.platformAccessory(this.config.name || 'Philips TV', uuid);
      accessory.context.device = {
        ip: this.config.ip,
        mac: this.config.mac,
        name: this.config.name,
      };
      new PhilipsAmbilightTVAccessory(this, accessory);
      try {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
      } catch (error) {
        this.log.error('Failed to register accessory:', error);
      }
    }
  }
}
