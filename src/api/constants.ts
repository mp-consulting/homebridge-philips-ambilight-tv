/**
 * Philips TV API Constants
 */

export const TV_API_PORT = 1926;
export const TV_API_VERSION = 6;

// Timeouts (in milliseconds)
export const DISCOVERY_TIMEOUT = 5000;
export const CONNECTION_TIMEOUT = 5000;
export const PAIRING_TIMEOUT = 10000;

// Wake-on-LAN
export const WOL_PORT = 9;
export const WOL_BROADCAST_IP = '255.255.255.255';

// Philips TV shared secret key for signature verification (from ha-philipsjs)
export const AUTH_SHARED_KEY = Buffer.from(
  'ZmVay1EQVFOaZhwQ4Kv81ypLAZNczV9sG4KkseXWn1NEk6cXmPKO/MCa9sryslvLCFMnNe4Z4CPXzToowvhHvA==',
  'base64',
);

// User-friendly error messages for HTTP status codes
export const ERROR_MESSAGES: Record<number, string> = {
  401: 'Invalid PIN code. Please check the PIN on your TV screen and try again.',
  403: 'Access denied. The TV rejected the pairing request.',
  404: 'Pairing endpoint not found. Your TV may not support this pairing method.',
  408: 'Request timeout. The TV took too long to respond.',
  500: 'TV internal error. Please try again.',
  503: 'TV is temporarily unavailable. Please try again later.',
};
