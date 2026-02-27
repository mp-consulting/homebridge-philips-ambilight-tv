/**
 * Philips TV API Module
 *
 * Exports all API components for use in the plugin and UI server.
 */

// Constants
export * from './constants.js';

// Types
export * from './types.js';

// Utilities
export {
  buildUrl,
  hmacSignature,
  md5,
  parseErrorResponse,
  fetchWithTimeout,
  postToTv,
  getFromTv,
  parseWwwAuthenticate,
  createDigestAuth,
  createDeviceInfo,
  handleErrorResponse,
  httpsAgent,
  sanitizeForHomeKit,
} from './utils.js';

// TV Client
export { PhilipsTVClient, HDMI_SOURCES, WATCH_TV_URI } from './PhilipsTVClient.js';
export type { PhilipsTVClientConfig } from './PhilipsTVClient.js';
