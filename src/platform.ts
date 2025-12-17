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
  // track UUIDs that we've initialized handlers for (prevent double initialization)
  public readonly processedUUIDs: Set<string> = new Set();

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
    // If we've already seen this UUID during this startup, it's a duplicate entry
    // in the cachedAccessories file — ignore the duplicate to avoid double initialization.
    if (this.accessories.has(accessory.UUID) || this.discoveredCacheUUIDs.includes(accessory.UUID)) {
      this.log.warn('Ignoring duplicate cached accessory:', accessory.displayName, accessory.UUID);
      return;
    }

    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.accessories.set(accessory.UUID, accessory);
    this.discoveredCacheUUIDs.push(accessory.UUID);
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  discoverDevices() {
    // Only support `devices` array in the platform config. Do not use single-device
    // top-level keys — this keeps the plugin configuration clear when multiple TVs
    // are present.
    if (!Array.isArray(this.config.devices) || this.config.devices.length === 0) {
      this.log.info('No TV devices configured. Please add a `devices` array in your platform config.');
      return;
    }

    const devices: Array<any> = this.config.devices;

    for (const device of devices) {
      if (!device.ip && !device.mac) {
        this.log.warn('Skipping device with missing ip and mac:', device.name);
        continue;
      }

      // 1) Prefer to find an existing cached accessory by mac or ip
      let matchedAccessory: PlatformAccessory | undefined;
      for (const [, acc] of this.accessories) {
        const ctx = (acc.context && acc.context.device) || {};
        if (ctx.mac === device.mac || ctx.ip === device.ip) {
          matchedAccessory = acc;
          break;
        }
      }

      if (matchedAccessory) {
        const uuid = matchedAccessory.UUID;

        // If we've already initialized this accessory, skip to avoid double handlers
        if (this.processedUUIDs.has(uuid)) {
          this.log.info('Accessory already initialized for this UUID, skipping:', uuid);
          continue;
        }

        // Update stored context with any config changes (pin, credentials, name)
        matchedAccessory.context.device = {
          ...(matchedAccessory.context?.device || {}),
          ip: device.ip,
          mac: device.mac,
          name: device.name,
          pin: device.pin,
          username: device.username,
          password: device.password,
        };

        this.log.info('Restoring existing accessory from cache:', matchedAccessory.displayName);
        new PhilipsAmbilightTVAccessory(this, matchedAccessory);
        this.processedUUIDs.add(uuid);
        continue;
      }

      // 2) No matching cached accessory found — create a stable UUID from mac/ip seed
      const idSeed = `${device.mac || device.ip}`;
      const uuid = this.api.hap.uuid.generate('PhilipsAmbilightTV-Unique-' + idSeed);
      this.log.info('Discovering device with UUID:', uuid, 'name:', device.name);

      // If an accessory with this UUID already exists in the map (edge-case), restore it
      const existingAccessory = this.accessories.get(uuid);
      if (existingAccessory) {
        if (!this.processedUUIDs.has(uuid)) {
          existingAccessory.context.device = {
            ...(existingAccessory.context?.device || {}),
            ip: device.ip,
            mac: device.mac,
            name: device.name,
            pin: device.pin,
            username: device.username,
            password: device.password,
          };
          this.log.info('Restoring existing accessory from cache (by UUID):', existingAccessory.displayName);
          new PhilipsAmbilightTVAccessory(this, existingAccessory);
          this.processedUUIDs.add(uuid);
        } else {
          this.log.info('Accessory already initialized for this UUID, skipping:', uuid);
        }
        continue;
      }

      // 3) Completely new accessory — create and register it
      this.log.info('Adding new accessory:', device.name);
      const accessory = new this.api.platformAccessory(device.name || 'Philips TV', uuid);
      accessory.context.device = {
        ip: device.ip,
        mac: device.mac,
        name: device.name,
        pin: device.pin,
        username: device.username,
        password: device.password,
      };
      new PhilipsAmbilightTVAccessory(this, accessory);
      try {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
        this.processedUUIDs.add(uuid);
      } catch (error) {
        this.log.error('Failed to register accessory:', error);
      }
    }
  }
}
