/**
 * Philips TV API Types
 */

export interface DeviceInfo {
  device_name: string;
  device_os: string;
  app_name: string;
  type: string;
  app_id: string;
  id: string;
}

export interface PairRequest {
  access: {
    scope: string[];
  };
  device: DeviceInfo;
}

export interface PairResponse {
  auth_key: string;
  timestamp: number;
}

export interface GrantRequest {
  auth: {
    auth_appId: string;
    auth_timestamp: number;
    auth_signature: string;
    pin: string;
  };
  device: DeviceInfo;
}

export interface GrantResponse {
  error_id?: string;
  error_text?: string;
}

export interface PairingSession {
  auth_key: string;
  timestamp: number;
  device: DeviceInfo;
}

export interface ApiResult<T = unknown> {
  success: boolean;
  error?: string;
  data?: T;
  details?: string;
}

export interface PairingResult extends ApiResult {
  auth_key?: string;
  timestamp?: number;
  message?: string;
}

export interface GrantResult extends ApiResult {
  username?: string;
  password?: string;
  message?: string;
}

export interface SystemInfo {
  name?: string;
  country?: string;
  model?: string;
  serialnumber?: string;
  softwareversion?: string;
  [key: string]: unknown;
}

export interface DigestAuthParams {
  realm: string;
  nonce: string;
  qop: string;
  opaque?: string;
}

export interface FetchOptions {
  headers?: Record<string, string>;
  timeout?: number;
}

export interface DiscoveredDevice {
  name: string;
  host: string;
  addresses: string[];
  port: number;
  txt?: Record<string, string>;
  type: string;
}

// ============================================================================
// TV API TYPES
// ============================================================================

export interface PowerState {
  powerstate: 'On' | 'Standby';
}

export interface VolumeState {
  current: number;
  min: number;
  max: number;
  muted: boolean;
}

export interface TVSource {
  id: string;
  name: string;
  type?: string;
}

export interface TVSourceList {
  sources?: TVSource[];
}

export interface TVApplication {
  id: string;
  label: string;
  intent?: {
    component?: {
      packageName?: string;
      className?: string;
    };
    action?: string;
  };
  order?: number;
  type?: string;
}

export interface TVApplicationList {
  applications?: TVApplication[];
  version?: number;
}

export interface TVChannel {
  ccid: number;
  name: string;
  preset?: string;
  onid?: number;
  tsid?: number;
  sid?: number;
}

export interface TVChannelList {
  Channel?: TVChannel[];
  version?: number;
}

export interface CurrentActivity {
  pkg?: {
    name?: string;
    className?: string;
  };
  component?: {
    packageName?: string;
    className?: string;
  };
}

export interface AmbilightState {
  styleName?: string;
  isExpert?: boolean;
  menuSetting?: string;
}

export type RemoteKey =
  | 'Standby'
  | 'Back'
  | 'Find'
  | 'RedColour'
  | 'GreenColour'
  | 'YellowColour'
  | 'BlueColour'
  | 'Home'
  | 'VolumeUp'
  | 'VolumeDown'
  | 'Mute'
  | 'Options'
  | 'Dot'
  | 'Digit0'
  | 'Digit1'
  | 'Digit2'
  | 'Digit3'
  | 'Digit4'
  | 'Digit5'
  | 'Digit6'
  | 'Digit7'
  | 'Digit8'
  | 'Digit9'
  | 'Info'
  | 'CursorUp'
  | 'CursorDown'
  | 'CursorLeft'
  | 'CursorRight'
  | 'Confirm'
  | 'Next'
  | 'Previous'
  | 'Adjust'
  | 'WatchTV'
  | 'Viewmode'
  | 'Teletext'
  | 'Subtitle'
  | 'ChannelStepUp'
  | 'ChannelStepDown'
  | 'Source'
  | 'AmbilightOnOff'
  | 'PlayPause'
  | 'Pause'
  | 'FastForward'
  | 'Stop'
  | 'Rewind'
  | 'Record'
  | 'Online';

export interface TVDeviceConfig {
  name: string;
  ip: string;
  mac: string;
  username: string;
  password: string;
  pollingInterval?: number;
  wakeOnLanEnabled?: boolean;
  inputs?: InputConfig[];
}

export interface InputConfig {
  name: string;
  type: 'app' | 'source' | 'channel';
  identifier: string;
  displayOrder?: number;
}
