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

export interface TapoLightState {
  on: boolean;
  brightness: number;
  hue?: number;
  saturation?: number;
  colorTemperature?: number;
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
