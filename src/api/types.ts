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
