/**
 * Tapo Platform
 * Main platform class that manages all Tapo accessories
 */

import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { TapoLightAccessory } from './lightAccessory';
import { TapoPlatformConfig, TapoDeviceConfig, TapoCredentials } from './types';
import { getDecryptedCredentials, discoverDevices } from './utils';

export class TapoPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // Track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];
  
  // Track active accessory instances
  private readonly activeAccessories: Map<string, TapoLightAccessory> = new Map();
  
  public readonly config: TapoPlatformConfig;
  public readonly credentials: TapoCredentials;

  constructor(
    public readonly log: Logger,
    config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.config = config as TapoPlatformConfig;
    
    // Validate configuration
    if (!this.config.email || !this.config.password) {
      this.log.error('TP-Link account email and password are required in config');
      this.credentials = { email: '', password: '' };
      return;
    }
    
    // Decrypt credentials if encrypted
    try {
      const storagePath = this.api.user.storagePath();
      this.credentials = getDecryptedCredentials(this.config, storagePath);
      this.log.info('Credentials loaded successfully');
    } catch (error) {
      this.log.error('Failed to decrypt credentials:', error);
      this.credentials = { email: '', password: '' };
      return;
    }
    
    if (!this.config.devices || this.config.devices.length === 0) {
      this.log.warn('No devices configured');
      return;
    }

    this.log.info('Platform initialized:', this.config.name || 'Tapo Platform');

    // Setup custom UI server for device discovery
    this.setupCustomUIServer();

    // When Homebridge finishes loading cached accessories, discover devices
    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });
  }

  /**
   * Setup custom UI server endpoints
   */
  private setupCustomUIServer() {
    // The custom UI makes POST requests to /discover
    // Homebridge Config UI X handles this automatically with customUi: true
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  /**
   * Discover and register devices from the configuration
   */
  discoverDevices() {
    const configuredDevices = new Set<string>();

    // Register each device from config
    for (const deviceConfig of this.config.devices) {
      // Generate a unique id for the accessory
      const uuid = this.api.hap.uuid.generate(deviceConfig.ip);
      configuredDevices.add(uuid);

      // Check if accessory already exists
      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

      if (existingAccessory) {
        // Accessory exists, update it
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
        
        // Update accessory context
        existingAccessory.context.device = deviceConfig;
        this.api.updatePlatformAccessories([existingAccessory]);

        // Create the accessory handler
        this.createAccessory(existingAccessory, deviceConfig);

      } else {
        // Create new accessory
        this.log.info('Adding new accessory:', deviceConfig.name);
        
        const accessory = new this.api.platformAccessory(deviceConfig.name, uuid);
        accessory.context.device = deviceConfig;

        // Create the accessory handler
        this.createAccessory(accessory, deviceConfig);

        // Register the accessory
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }

    // Remove accessories that are no longer configured
    const accessoriesToRemove = this.accessories.filter(
      accessory => !configuredDevices.has(accessory.UUID)
    );

    if (accessoriesToRemove.length > 0) {
      this.log.info('Removing unconfigured accessories:', 
        accessoriesToRemove.map(a => a.displayName).join(', '));
      
      // Cleanup active accessories
      for (const accessory of accessoriesToRemove) {
        const instance = this.activeAccessories.get(accessory.UUID);
        if (instance) {
          instance.destroy();
          this.activeAccessories.delete(accessory.UUID);
        }
      }

      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessoriesToRemove);
    }
  }

  /**
   * Create the appropriate accessory instance based on device type
   */
  private createAccessory(accessory: PlatformAccessory, config: TapoDeviceConfig) {
    // Remove old instance if it exists
    const oldInstance = this.activeAccessories.get(accessory.UUID);
    if (oldInstance) {
      oldInstance.destroy();
    }

    // Create new instance based on device type
    switch (config.type) {
      case 'light':
        const lightAccessory = new TapoLightAccessory(
          this,
          accessory,
          config,
          this.log,
        );
        this.activeAccessories.set(accessory.UUID, lightAccessory);
        break;

      default:
        this.log.warn(`Unsupported device type: ${config.type} for ${config.name}`);
    }
  }
}
