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
  isApiKeyEncrypted?: boolean; // Whether secretApiKey is encrypted
}

export interface TapoDeviceConfig {
  name: string;
  /**
   * Local IP address. Required for LAN devices (`light`), not needed for
   * cloud-controlled IR remotes (`ir-remote`).
   */
  ip?: string;
  type: 'light' | 'ir-remote';
  mac?: string;
  model?: string;
  /**
   * IR remote only: the cloud `thingName` of the IR remote sub-thing
   * (e.g. `802D3E1478A92CEA8BF45E3034FE94D9237E02B7030B0002`).
   * When omitted, the remote is matched by its decoded nickname.
   */
  thingName?: string;
  /**
   * IR remote only: optional list of IR key `name`s (e.g. `['POWER','VOL+']`)
   * to expose as HomeKit input sources. When omitted, all keys reported by the
   * remote are exposed.
   */
  irKeys?: string[];
  /**
   * IR remote only: optional display-name overrides, keyed by IR key name
   * (e.g. `{ 'OPT': 'Optical', 'LINE1': 'Line 1' }`). Without this, labels are
   * auto-cased from the remote's own names (LINE1 -> Line 1).
   */
  irLabels?: Record<string, string>;
  /**
   * IR remote only: optional list of IR key `name`s to expose as HomeKit
   * Switch buttons (tap to fire), e.g. `['MUTE','PLAY','PAUSE','NEXT','PREVIOUS']`.
   * When omitted, defaults to the transport set (MUTE/PLAY/PAUSE/NEXT/PREVIOUS).
   */
  irButtons?: string[];
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

export interface TapoResponse<T = unknown> {
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

// ── Cloud Thing API (v2) types ─────────────────────────────────────────

/**
 * A device/thing from the Tapo cloud `/v2/things` listing.
 * IR remotes appear as `category === 'ir.remote'` sub-things of the H110 hub.
 */
export interface TapoThingInfo {
  thingName: string;
  category: string;
  model?: string;
  /** Base64-encoded nickname (decode with decodeBase64Label) */
  nickname?: string;
  isSubThing?: boolean;
  status?: number;
  mac?: string;
  deviceId?: string;
  /** Region-specific app server for this thing (e.g. euw1-app-server...) */
  appServerUrlV2?: string;
  [key: string]: unknown;
}

/**
 * An IR key as reported by `getKeyListInfo`.
 * `name` is what you send to `sendIrCmdById`; `display_name` is base64.
 */
export interface TapoIrKey {
  name: string;
  id: number;
  pwm?: number;
  display_name?: string;
  ac_status?: string;
}

/**
 * Service URLs resolved from `getAppServiceUrlByCloudUserName`
 */
export interface TapoCloudServiceUrls {
  appServer: string;
  cloudGateway?: string;
  security: string;
}

/**
 * Response shape for a services-sync passthrough call.
 * This is the `outputParams.responseData` payload:
 * `{ result: { responses: [ { method, error_code, result } ] } }`
 */
export interface TapoPassthroughResponse {
  requestId?: string;
  result?: {
    responses?: Array<{
      method?: string;
      error_code?: number;
      result?: Record<string, unknown>;
    }>;
  };
}

/**
 * Common interface for accessory handlers managed by the platform.
 * Both TapoLightAccessory and IrRemoteAccessory implement this.
 */
export interface TapoAccessory {
  destroy(): void;
  initializeDevice(): Promise<void>;
}
