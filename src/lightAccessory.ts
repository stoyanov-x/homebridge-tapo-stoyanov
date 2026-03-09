/**
 * Tapo Light Bulb Accessory
 * Represents a Tapo smart light bulb in HomeKit
 */

import {
  Service,
  PlatformAccessory,
  CharacteristicValue,
  Logger,
} from 'homebridge';

import { TapoPlatform } from './platform';
import { TapoClient } from './tapoClient';
import { TapoDeviceConfig, TapoDeviceInfo } from './types';

export class TapoLightAccessory {
  private service: Service;
  private client: TapoClient;
  private updateInterval?: NodeJS.Timeout;

  // Current state cache
  private state = {
    On: false,
    Brightness: 100,
    ColorTemperature: 140, // HomeKit uses Mired (1,000,000/Kelvin)
    Hue: 0,
    Saturation: 0,
  };

  // Device capabilities
  private colorTempRange: [number, number] = [2500, 6500];

  constructor(
    private readonly platform: TapoPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly config: TapoDeviceConfig,
    private readonly log: Logger,
  ) {
    // Initialize the Tapo client with decrypted credentials
    this.client = new TapoClient(config.ip, this.platform.credentials);

    // Set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'TP-Link')
      .setCharacteristic(this.platform.Characteristic.Model, 'L430C')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, config.ip.replace(/\./g, '-'));

    // Get or create the Lightbulb service
    this.service = this.accessory.getService(this.platform.Service.Lightbulb) 
      || this.accessory.addService(this.platform.Service.Lightbulb);

    // Set the service name
    this.service.setCharacteristic(this.platform.Characteristic.Name, config.name);

    // Register handlers for the On characteristic
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    // Register handlers for Brightness
    this.service.getCharacteristic(this.platform.Characteristic.Brightness)
      .onSet(this.setBrightness.bind(this))
      .onGet(this.getBrightness.bind(this));

    // Register handlers for ColorTemperature
    this.service.getCharacteristic(this.platform.Characteristic.ColorTemperature)
      .onSet(this.setColorTemperature.bind(this))
      .onGet(this.getColorTemperature.bind(this));

    // Register handlers for Hue
    this.service.getCharacteristic(this.platform.Characteristic.Hue)
      .onSet(this.setHue.bind(this))
      .onGet(this.getHue.bind(this));

    // Register handlers for Saturation
    this.service.getCharacteristic(this.platform.Characteristic.Saturation)
      .onSet(this.setSaturation.bind(this))
      .onGet(this.getSaturation.bind(this));

    // Initialize device state and start polling
    this.initialize();
  }

  /**
   * Initialize the accessory - get initial state and start polling
   */
  private async initialize() {
    try {
      await this.updateDeviceState();
      
      // Start polling for state updates
      const pollingInterval = (this.platform.config.pollingInterval || 30) * 1000;
      this.updateInterval = setInterval(() => {
        this.updateDeviceState().catch(err => {
          this.log.error(`Error updating ${this.config.name}:`, err.message);
        });
      }, pollingInterval);

      this.log.info(`Initialized ${this.config.name} at ${this.config.ip}`);
    } catch (error: any) {
      this.log.error(`Failed to initialize ${this.config.name}:`, error.message);
    }
  }

  /**
   * Update device state from the physical device
   */
  private async updateDeviceState(): Promise<void> {
    try {
      const info: TapoDeviceInfo = await this.client.getDeviceInfo();
      
      // Update color temperature range if available
      if (info.color_temp_range) {
        this.colorTempRange = info.color_temp_range;
      }

      // Update cached state
      this.state.On = info.device_on;
      this.state.Brightness = info.brightness;
      
      if (info.color_temp) {
        // Convert Kelvin to Mired
        this.state.ColorTemperature = Math.round(1000000 / info.color_temp);
      }
      
      if (info.hue !== undefined) {
        this.state.Hue = info.hue;
      }
      
      if (info.saturation !== undefined) {
        this.state.Saturation = info.saturation;
      }

      // Update HomeKit with the new values (but don't trigger handlers)
      this.service.updateCharacteristic(this.platform.Characteristic.On, this.state.On);
      this.service.updateCharacteristic(this.platform.Characteristic.Brightness, this.state.Brightness);
      this.service.updateCharacteristic(this.platform.Characteristic.ColorTemperature, this.state.ColorTemperature);
      this.service.updateCharacteristic(this.platform.Characteristic.Hue, this.state.Hue);
      this.service.updateCharacteristic(this.platform.Characteristic.Saturation, this.state.Saturation);

    } catch (error: any) {
      this.log.debug(`Error updating state for ${this.config.name}:`, error.message);
      throw error;
    }
  }

  /**
   * Handle SET requests for On characteristic
   */
  async setOn(value: CharacteristicValue) {
    const on = value as boolean;
    
    try {
      if (on) {
        await this.client.turnOn();
      } else {
        await this.client.turnOff();
      }
      
      this.state.On = on;
      this.log.info(`Set ${this.config.name} power to ${on ? 'ON' : 'OFF'}`);
    } catch (error: any) {
      this.log.error(`Error setting power for ${this.config.name}:`, error.message);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * Handle GET requests for On characteristic
   */
  async getOn(): Promise<CharacteristicValue> {
    return this.state.On;
  }

  /**
   * Handle SET requests for Brightness characteristic
   */
  async setBrightness(value: CharacteristicValue) {
    const brightness = value as number;
    
    try {
      await this.client.setBrightness(brightness);
      this.state.Brightness = brightness;
      this.log.info(`Set ${this.config.name} brightness to ${brightness}%`);
    } catch (error: any) {
      this.log.error(`Error setting brightness for ${this.config.name}:`, error.message);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * Handle GET requests for Brightness characteristic
   */
  async getBrightness(): Promise<CharacteristicValue> {
    return this.state.Brightness;
  }

  /**
   * Handle SET requests for ColorTemperature characteristic
   */
  async setColorTemperature(value: CharacteristicValue) {
    const mired = value as number;
    
    try {
      // Convert Mired to Kelvin
      const kelvin = Math.round(1000000 / mired);
      
      // Clamp to device range
      const clampedKelvin = Math.max(
        this.colorTempRange[0],
        Math.min(this.colorTempRange[1], kelvin)
      );
      
      await this.client.setColorTemperature(clampedKelvin);
      this.state.ColorTemperature = mired;
      this.log.info(`Set ${this.config.name} color temperature to ${clampedKelvin}K`);
    } catch (error: any) {
      this.log.error(`Error setting color temperature for ${this.config.name}:`, error.message);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * Handle GET requests for ColorTemperature characteristic
   */
  async getColorTemperature(): Promise<CharacteristicValue> {
    return this.state.ColorTemperature;
  }

  /**
   * Handle SET requests for Hue characteristic
   */
  async setHue(value: CharacteristicValue) {
    const hue = value as number;
    this.state.Hue = hue;
    
    // Apply the color (we wait for both hue and saturation to be set)
    await this.applyColor();
  }

  /**
   * Handle GET requests for Hue characteristic
   */
  async getHue(): Promise<CharacteristicValue> {
    return this.state.Hue;
  }

  /**
   * Handle SET requests for Saturation characteristic
   */
  async setSaturation(value: CharacteristicValue) {
    const saturation = value as number;
    this.state.Saturation = saturation;
    
    // Apply the color (we wait for both hue and saturation to be set)
    await this.applyColor();
  }

  /**
   * Handle GET requests for Saturation characteristic
   */
  async getSaturation(): Promise<CharacteristicValue> {
    return this.state.Saturation;
  }

  /**
   * Apply the current hue and saturation to the device
   * Uses a small delay to batch color changes
   */
  private colorUpdateTimeout?: NodeJS.Timeout;
  
  private async applyColor() {
    // Clear any pending color update
    if (this.colorUpdateTimeout) {
      clearTimeout(this.colorUpdateTimeout);
    }

    // Batch the color update with a small delay
    this.colorUpdateTimeout = setTimeout(async () => {
      try {
        await this.client.setColor(this.state.Hue, this.state.Saturation);
        this.log.info(`Set ${this.config.name} color to H:${this.state.Hue} S:${this.state.Saturation}`);
      } catch (error: any) {
        this.log.error(`Error setting color for ${this.config.name}:`, error.message);
      }
    }, 100);
  }

  /**
   * Cleanup when accessory is removed
   */
  destroy() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    
    if (this.colorUpdateTimeout) {
      clearTimeout(this.colorUpdateTimeout);
    }
    
    this.client.close();
    this.log.info(`Removed ${this.config.name}`);
  }
}
