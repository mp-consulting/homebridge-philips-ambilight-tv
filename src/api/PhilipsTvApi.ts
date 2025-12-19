/**
 * Philips TV API Client
 *
 * Handles communication with Philips Android TVs using the JointSpace API v6.
 */

import { TV_API_PORT, TV_API_VERSION, CONNECTION_TIMEOUT, PAIRING_TIMEOUT } from './constants.js';
import {
  buildUrl,
  hmacSignature,
  postToTv,
  getFromTv,
  createDigestAuth,
  createDeviceInfo,
  handleErrorResponse,
} from './utils.js';
import type {
  PairingSession,
  PairingResult,
  GrantResult,
  ApiResult,
  SystemInfo,
  PairRequest,
  GrantRequest,
  PairResponse,
  GrantResponse,
} from './types.js';

export class PhilipsTvApi {
  private pairingSessions = new Map<string, PairingSession>();

  /**
   * Test connection to TV
   */
  async testConnection(ip: string): Promise<ApiResult> {
    try {
      console.log(`[PhilipsTvApi] Testing connection to ${ip}`);

      const response = await getFromTv(ip, '/system', { timeout: CONNECTION_TIMEOUT });
      console.log(`[PhilipsTvApi] Response status: ${response.status}`);

      // 401 is expected if not paired, but means API is accessible
      if (response.ok || response.status === 401) {
        return { success: true };
      }

      return { success: false, error: `TV responded with status ${response.status}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[PhilipsTvApi] Connection test failed:', message);
      return {
        success: false,
        error: `Cannot reach TV at ${ip}:${TV_API_PORT}. Please check:\n1) TV is powered on\n2) TV is connected to the same network`,
        details: message,
      };
    }
  }

  /**
   * Start pairing with TV (Step 1)
   * Sends pairing request and TV displays PIN
   */
  async startPairing(ip: string, deviceName = 'Homebridge'): Promise<PairingResult> {
    try {
      console.log(`[PhilipsTvApi] Starting pairing with TV at ${ip}`);

      // Test connection first
      const testResult = await this.testConnection(ip);
      if (!testResult.success) {
        return testResult;
      }

      console.log('[PhilipsTvApi] Connection test passed, proceeding with pairing...');

      const device = createDeviceInfo(deviceName);
      const pairRequest: PairRequest = {
        access: { scope: ['read', 'write', 'control'] },
        device,
      };

      console.log('[PhilipsTvApi] Sending pairing request...');

      const response = await postToTv(ip, '/pair/request', pairRequest, { timeout: PAIRING_TIMEOUT });

      if (!response.ok) {
        return handleErrorResponse(response, 'Pairing');
      }

      const result = await response.json() as PairResponse;

      // Store session for grant step
      this.pairingSessions.set(ip, {
        auth_key: result.auth_key,
        timestamp: result.timestamp,
        device,
      });

      return {
        success: true,
        auth_key: result.auth_key,
        timestamp: result.timestamp,
        message: 'Check your TV screen for the PIN code',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[PhilipsTvApi] Pairing error:', message);
      return { success: false, error: message || 'Failed to initiate pairing' };
    }
  }

  /**
   * Complete pairing with PIN (Step 2)
   */
  async completePairing(ip: string, pin: string): Promise<GrantResult> {
    const session = this.pairingSessions.get(ip);
    if (!session) {
      return { success: false, error: 'No active pairing session found' };
    }

    try {
      console.log('[PhilipsTvApi] Processing PIN...');

      const signature = hmacSignature(session.timestamp.toString(), pin);

      const grantRequest: GrantRequest = {
        auth: {
          auth_appId: '1',
          auth_timestamp: session.timestamp,
          auth_signature: signature,
          pin,
        },
        device: session.device,
      };

      // First request to get digest challenge
      const initialResponse = await postToTv(ip, '/pair/grant', grantRequest, { timeout: CONNECTION_TIMEOUT });

      // Handle digest authentication challenge
      if (initialResponse.status === 401) {
        const wwwAuth = initialResponse.headers.get('www-authenticate');

        if (wwwAuth?.toLowerCase().startsWith('digest')) {
          console.log('[PhilipsTvApi] Retrying with Digest auth...');

          const digestAuth = createDigestAuth(
            session.device.id,
            session.auth_key,
            wwwAuth,
            'POST',
            `/${TV_API_VERSION}/pair/grant`,
          );

          const response = await postToTv(ip, '/pair/grant', grantRequest, {
            headers: { 'Authorization': digestAuth },
            timeout: CONNECTION_TIMEOUT,
          });

          if (!response.ok) {
            return handleErrorResponse(response, 'PairGrant');
          }

          const result = await response.json() as GrantResponse;

          if (result.error_id && result.error_id !== 'SUCCESS') {
            return { success: false, error: `Pairing failed: ${result.error_id} - ${result.error_text || ''}` };
          }

          this.pairingSessions.delete(ip);
          return {
            success: true,
            username: session.device.id,
            password: session.auth_key,
            message: 'Pairing successful!',
          };
        }
      }

      // Handle non-401 error responses
      if (!initialResponse.ok) {
        return handleErrorResponse(initialResponse, 'PairGrant');
      }

      // Success without digest auth (rare case)
      this.pairingSessions.delete(ip);
      return {
        success: true,
        username: session.device.id,
        password: session.auth_key,
        message: 'Pairing successful!',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[PhilipsTvApi] Grant error:', message);
      return { success: false, error: message || 'Failed to complete pairing' };
    }
  }

  /**
   * Get system information from TV
   */
  async getSystemInfo(ip: string, username?: string, password?: string): Promise<ApiResult<SystemInfo>> {
    try {
      console.log(`[PhilipsTvApi] Getting system info from ${ip}`);

      const initialResponse = await getFromTv(ip, '/system', { timeout: CONNECTION_TIMEOUT });

      // Handle digest authentication if needed
      if (initialResponse.status === 401 && username && password) {
        const wwwAuth = initialResponse.headers.get('www-authenticate');

        if (wwwAuth?.toLowerCase().startsWith('digest')) {
          const digestAuth = createDigestAuth(username, password, wwwAuth, 'GET', `/${TV_API_VERSION}/system`);

          const response = await getFromTv(ip, '/system', {
            headers: { 'Authorization': digestAuth },
            timeout: CONNECTION_TIMEOUT,
          });

          if (response.ok) {
            const systemInfo = await response.json() as SystemInfo;
            console.log('[PhilipsTvApi] System info retrieved successfully');
            return { success: true, data: systemInfo };
          }
        }
      }

      // No auth needed
      if (initialResponse.ok) {
        const systemInfo = await initialResponse.json() as SystemInfo;
        console.log('[PhilipsTvApi] System info retrieved successfully');
        return { success: true, data: systemInfo };
      }

      return { success: false, error: `Failed to get system info: ${initialResponse.status}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[PhilipsTvApi] System info error:', message);
      return { success: false, error: message || 'Failed to get system information' };
    }
  }

  /**
   * Make an authenticated GET request to TV API
   */
  async get<T = unknown>(
    ip: string,
    endpoint: string,
    username: string,
    password: string,
  ): Promise<ApiResult<T>> {
    try {
      const initialResponse = await getFromTv(ip, endpoint, { timeout: CONNECTION_TIMEOUT });

      if (initialResponse.status === 401) {
        const wwwAuth = initialResponse.headers.get('www-authenticate');

        if (wwwAuth?.toLowerCase().startsWith('digest')) {
          const digestAuth = createDigestAuth(username, password, wwwAuth, 'GET', `/${TV_API_VERSION}${endpoint}`);

          const response = await getFromTv(ip, endpoint, {
            headers: { 'Authorization': digestAuth },
            timeout: CONNECTION_TIMEOUT,
          });

          if (response.ok) {
            const data = await response.json() as T;
            return { success: true, data };
          }

          return handleErrorResponse(response, 'API GET');
        }
      }

      if (initialResponse.ok) {
        const data = await initialResponse.json() as T;
        return { success: true, data };
      }

      return handleErrorResponse(initialResponse, 'API GET');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message };
    }
  }

  /**
   * Make an authenticated POST request to TV API
   */
  async post<T = unknown>(
    ip: string,
    endpoint: string,
    body: unknown,
    username: string,
    password: string,
  ): Promise<ApiResult<T>> {
    try {
      const initialResponse = await postToTv(ip, endpoint, body, { timeout: CONNECTION_TIMEOUT });

      if (initialResponse.status === 401) {
        const wwwAuth = initialResponse.headers.get('www-authenticate');

        if (wwwAuth?.toLowerCase().startsWith('digest')) {
          const digestAuth = createDigestAuth(username, password, wwwAuth, 'POST', `/${TV_API_VERSION}${endpoint}`);

          const response = await postToTv(ip, endpoint, body, {
            headers: { 'Authorization': digestAuth },
            timeout: CONNECTION_TIMEOUT,
          });

          if (response.ok) {
            const data = await response.json() as T;
            return { success: true, data };
          }

          return handleErrorResponse(response, 'API POST');
        }
      }

      if (initialResponse.ok) {
        const data = await initialResponse.json() as T;
        return { success: true, data };
      }

      return handleErrorResponse(initialResponse, 'API POST');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message };
    }
  }
}

// Export singleton instance for convenience
export const philipsTvApi = new PhilipsTvApi();
