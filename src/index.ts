import type { API } from 'homebridge';

import { PhilipsAmbilightTVPlatform } from './platform.js';
import { PLATFORM_NAME } from './settings.js';

/** Supported Node.js lines and their minimum minor version — keep in step
 *  with `engines.node` in package.json. */
const SUPPORTED_NODE_VERSIONS: Readonly<Record<number, number>> = {
  22: 10,
  24: 0,
  26: 0,
};

const SUPPORTED_NODE_RANGE = '^22.10.0 || ^24.0.0 || ^26.0.0';

/**
 * Check if the given Node.js version string meets the minimum requirements.
 */
export const isSupportedNodeVersion = (version: string): boolean => {
  const match = version.match(/^v(\d+)\.(\d+)\.\d+/);
  if (!match) {
    return false;
  }
  const minMinor = SUPPORTED_NODE_VERSIONS[parseInt(match[1], 10)];
  return minMinor !== undefined && parseInt(match[2], 10) >= minMinor;
};

/**
 * This method registers the platform with Homebridge
 */
export default (api: API) => {
  if (!isSupportedNodeVersion(process.version)) {
    console.warn(
      `[PhilipsAmbilightTV] WARNING: Node.js ${process.version} is not supported. ` +
      `This plugin requires Node.js ${SUPPORTED_NODE_RANGE}. Some features may not work correctly.`,
    );
  }
  api.registerPlatform(PLATFORM_NAME, PhilipsAmbilightTVPlatform);
};
