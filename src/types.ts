/**
 * Type definitions for the Tapo platform
 */

export interface TapoPlatformConfig {
  platform: string;
  name?: string;
  email: string;
  password: string;
  isEncrypted?: boolean;
  devices: TapoDeviceConfig[];
  pollingInterval?: number;
  
  // Secret Request configuration (optional)
  credentialType?: 'traditional' | 'secret-request';
  secretName?: string;
  secretServerUrl?: string;
  secretTimeout?: number; // seconds (3600-172800, default: 43200 = 12h)
  secretApiKey?: string; // API key for secret-request server (can also use SECRET_API_KEY env var)
}

export interface TapoDeviceConfig {
  name: string;
  ip: string;
  type: 'light';
  mac?: string;
  model?: string;
}

export interface TapoDeviceInfo {
  overheated: boolean;
  ip: string;
  mac: string;
  model: string;
  hw_ver: string;
  fw_ver: string;
  device_id: string;
  type: string;
  nickname: string;
  
  // Light-specific properties
  device_on: boolean;
  brightness: number;
  hue?: number;
  saturation?: number;
  color_temp?: number;
  color_temp_range?: [number, number];
  
  // Optional features
  dynamic_light_effect_enable?: boolean;
  auto_biorhythm_light_enable?: boolean;
}

export interface TapoResponse<T = any> {
  error_code: number;
  result?: T;
  method?: string;
  msg?: string;
}

export interface TapoCredentials {
  email: string;
  password: string;
}

export interface DiscoveredDevice {
  name: string;
  nickname?: string;
  ip: string;
  mac: string;
  model: string;
  type: string;
  online: boolean;
  device_on?: boolean;
  hw_ver?: string;
  fw_ver?: string;
}

/**
 * State of Secret Request background service
 */
export type SecretRequestState = 
  | 'idle'           // Not started or disabled
  | 'requesting'     // Waiting for user approval
  | 'delivered'      // Secret received successfully
  | 'denied'         // User denied the request
  | 'timeout'        // Request timed out
  | 'error';         // Error occurred

/**
 * Secret Request status information
 */
export interface SecretRequestStatus {
  state: SecretRequestState;
  requestStartTime?: Date;
  timeoutSeconds?: number;
  errorMessage?: string;
  requestId?: string;
}
