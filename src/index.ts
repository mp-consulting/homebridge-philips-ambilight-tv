import type { API } from 'homebridge';

import { PhilipsAmbilightTVPlatform } from './platform.js';
import { PLATFORM_NAME } from './settings.js';

/**
 * Check if the current Node.js version meets the minimum requirements.
 * Supports ^20.18.0 || ^22.10.0
 */
const checkNodeVersion = (): boolean => {
  const match = process.version.match(/^v(\d+)\.(\d+)\.\d+/);
  if (!match) {
    return false;
  }
  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  return (major === 20 && minor >= 18) || (major === 22 && minor >= 10) || major >= 23;
};

/**
 * This method registers the platform with Homebridge
 */
export default (api: API) => {
  if (!checkNodeVersion()) {
    console.warn(
      `[PhilipsAmbilightTV] WARNING: Node.js ${process.version} is not supported. ` +
      'This plugin requires Node.js ^20.18.0 || ^22.10.0. Some features may not work correctly.',
    );
  }
  api.registerPlatform(PLATFORM_NAME, PhilipsAmbilightTVPlatform);
};
