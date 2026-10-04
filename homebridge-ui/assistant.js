import { registerAiRoutes } from '@mp-consulting/homebridge-ai-kit/plugin';

// ============================================================================
// CONSTANTS
// ============================================================================

export const ASSISTANT_PLUGIN_NAME = '@mp-consulting/homebridge-philips-ambilight-tv';

/**
 * Philips TV background the Assistant gets with every request from this
 * plugin's settings UI. Keep it short: it is sent with each prompt. The facts
 * come from src/api (constants.ts, utils.ts) and homebridge-ui/server.js.
 */
export const PHILIPS_TV_AI_CONTEXT = [
  'The plugin exposes Philips Android TVs (Ambilight) to HomeKit as Television accessories, all on the local network:',
  'it talks to the TV\'s JointSpace API v6 over HTTPS on port 1926 with Digest authentication and follows state with a',
  'long-poll on /6/notifychange plus regular polling ("pollingInterval", default 10000 ms).',
  'Discovery looks for the Android TV remote service over mDNS (_androidtvremote2._tcp) for about 5 seconds, so the TV',
  'must be on (not in deep standby) and on the same subnet/VLAN as Homebridge with mDNS allowed; otherwise enter the IP',
  'by hand. Pairing: the plugin asks the TV for a PIN (/pair/request), the TV shows a 4-digit PIN, and the grant',
  '(/pair/grant) returns the username and password (auth key) saved in the config. A pairing session expires after 5',
  'minutes ("No active pairing session found. Start pairing again."). Pairing errors from the TV: 401 invalid PIN,',
  '403 the TV rejected the pairing request, 404 pairing endpoint not found (older or non-Android TVs without JointSpace',
  'v6 pairing are not supported), 408 timeout, 500 TV internal error, 503 TV temporarily unavailable. "Cannot reach TV"',
  'means the TV is off or in standby, on another network, or the IP changed (a DHCP reservation helps).',
  'The TV certificate\'s SHA-256 fingerprint ("certFingerprint") is pinned at pairing; "TV certificate does not match the',
  'pinned fingerprint" or "different certificate during pairing" means the TV was reset or replaced (re-pair) or',
  'something on the network intercepts the connection. Turning the TV on from standby uses Wake-on-LAN to its MAC address',
  '(the TV\'s Wake on LAN / switch on with Wi-Fi or Chromecast setting must be enabled; Docker or several networks can',
  'send the packet out the wrong interface). A TV that just woke is slow to list its apps, so loading sources can time',
  'out until the Home screen shows. "Detect" for custom apps needs the app open in the foreground, not live TV or Home.',
  'Changing the MAC address spelling used to republish the TV as a new HomeKit accessory. Never ask the user for the',
  'pairing username, password (auth key) or API keys.',
].join(' ');

// ============================================================================
// REGISTRATION
// ============================================================================

/**
 * Adds the Assistant routes (/ai/status, /ai/explain, /ai/ask, /ai/config) to the
 * plugin UI server. The provider settings come from the shared `HomebridgeAiKit`
 * block in config.json; the key never reaches the browser.
 *
 * `options` is passed through to `registerAiRoutes` (tests inject a provider).
 */
export function registerAssistant(server, options = {}) {
  registerAiRoutes(server, {
    pluginName: ASSISTANT_PLUGIN_NAME,
    systemContext: PHILIPS_TV_AI_CONTEXT,
    ...options,
  });
}
