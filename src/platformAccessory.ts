import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { PhilipsAmbilightTVPlatform } from './platform.js';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class PhilipsAmbilightTVAccessory {
  private service: Service;



  constructor(
    private readonly platform: PhilipsAmbilightTVPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Philips')
      .setCharacteristic(this.platform.Characteristic.Model, 'Ambilight TV')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.mac || 'Default-Serial');

    // get the Television service if it exists, otherwise create a new Television service
    this.service = this.accessory.getService(this.platform.Service.Television) || this.accessory.addService(this.platform.Service.Television);

    // set the service name, this is what is displayed as the default name on the Home app
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name || 'Philips TV');

    // set sleep discovery characteristic
    this.service.setCharacteristic(this.platform.Characteristic.SleepDiscoveryMode, this.platform.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);

    // handle on / off events using the Active characteristic
    this.service.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setActive.bind(this))
      .onGet(this.getActive.bind(this));

    this.service.setCharacteristic(this.platform.Characteristic.ActiveIdentifier, 1);

    // handle input source changes
    this.service.getCharacteristic(this.platform.Characteristic.ActiveIdentifier)
      .onSet(this.setActiveIdentifier.bind(this))
      .onGet(this.getActiveIdentifier.bind(this));

    // handle remote control input
    this.service.getCharacteristic(this.platform.Characteristic.RemoteKey)
      .onSet(this.setRemoteKey.bind(this));
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  async setActive(value: CharacteristicValue) {
    // implement your own code to turn your device on/off
    this.platform.log.debug('Set Characteristic Active ->', value);
  }

  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Light bulb is on.
   */
  async getActive(): Promise<CharacteristicValue> {
    // implement your own code to check if the device is on
    const isActive = false;
    this.platform.log.debug('Get Characteristic Active ->', isActive);
    return isActive;
  }

  async setActiveIdentifier(value: CharacteristicValue) {
    this.platform.log.debug('Set Characteristic Active Identifier -> ', value);
  }

  async getActiveIdentifier(): Promise<CharacteristicValue> {
    const activeIdentifier = 1;
    this.platform.log.debug('Get Characteristic Active Identifier -> ', activeIdentifier);
    return activeIdentifier;
  }

  async setRemoteKey(value: CharacteristicValue) {
    this.platform.log.debug('Set Characteristic Remote Key -> ', value);
  }
}
