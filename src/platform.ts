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

  discoverDevices() {
    for (const tv of this.config.devices) {
      // generate a unique identifier for the accessory based on the TV's MAC address
      const uuid = this.api.hap.uuid.generate(PLATFORM_NAME + '-' + tv.mac);
      // see if an accessory with the same UUID has already been registered and restored from cache
      const existingAccessory = this.accessories.get(uuid);

      // if not, register a new accessory
      if (!existingAccessory) {
        this.log.info('Adding new accessory:', tv.name);

        // create a new accessory
        const accessory = new this.api.platformAccessory(tv.name, uuid, this.api.hap.Categories.TELEVISION);

        // store a copy of the device object in the `accessory.context`
        new PhilipsAmbilightTVAccessory(this, accessory);
        accessory.context.device = tv;

        // register the accessory
        this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);

        // store the accessory in the cache
        this.accessories.set(uuid, accessory);
      }
    }
  }
}