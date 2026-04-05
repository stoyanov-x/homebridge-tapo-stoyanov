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
import { getDecryptedCredentials, normalizeDeviceType, decryptCredential } from './utils';
import { SecretRequestService } from './secretRequestService';

export class TapoPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // Track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];
  
  // Track active accessory instances
  private readonly activeAccessories: Map<string, TapoLightAccessory> = new Map();
  
  public readonly config: TapoPlatformConfig;
  public credentials: TapoCredentials;
  private credentialMode: 'traditional' | 'secret-request';
  private secretRequestService?: SecretRequestService;
  private credentialsReady = false;
  private pendingAccessories: Array<{ accessory: PlatformAccessory; config: TapoDeviceConfig }> = [];

  constructor(
    public readonly log: Logger,
    config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.config = config as TapoPlatformConfig;
    
    // Determine credential mode (default to traditional for backward compatibility)
    this.credentialMode = this.config.credentialType || 'traditional';
    this.credentials = { email: '', password: '' }; // Will be populated based on mode
    
    // Load credentials based on mode
    if (this.credentialMode === 'traditional') {
      // Traditional mode: decrypt credentials from config
      if (!this.config.email || !this.config.password) {
        this.log.error('TP-Link account email and password are required in config for traditional mode');
        return;
      }
      
      try {
        const storagePath = this.api.user.storagePath();
        this.credentials = getDecryptedCredentials(this.config, storagePath);
        this.log.info('Credentials loaded successfully (traditional mode)');
        this.credentialsReady = true;
      } catch (error) {
        this.log.error('Failed to decrypt credentials:', error);
        return;
      }
    } else {
      // Secret Request mode: credentials will be delivered via push notification
      if (!this.config.secretName) {
        this.log.error('secretName is required in config for secret-request mode');
        return;
      }
      
      this.log.info('Using Secret Request mode - credentials will be requested from iPhone');
      this.credentialsReady = false;
      
      // Decrypt API key if encrypted
      let apiKey = this.config.secretApiKey;
      if (apiKey && this.config.isApiKeyEncrypted) {
        try {
          const storagePath = this.api.user.storagePath();
          const decrypted = decryptCredential(apiKey, storagePath);
          if (decrypted) {
            apiKey = decrypted;
            this.log.debug('[SecretRequest] API key decrypted successfully');
          } else {
            this.log.warn('[SecretRequest] Failed to decrypt API key');
          }
        } catch (error) {
          this.log.error('[SecretRequest] Error decrypting API key:', error);
        }
      }
      
      // Initialize Secret Request service
      this.secretRequestService = new SecretRequestService(
        {
          secretName: this.config.secretName,
          serverUrl: this.config.secretServerUrl,
          timeoutSeconds: this.config.secretTimeout,
          apiKey: apiKey,
        },
        this.log,
      );
      
      // Listen for credentials
      this.secretRequestService.on('credentialsReceived', (credentials: TapoCredentials) => {
        this.log.info('[SecretRequest] Credentials received, initializing devices...');
        this.credentials = credentials;
        this.credentialsReady = true;
        this.initializePendingAccessories();
      });
      
      this.secretRequestService.on('requestFailed', (error: Error) => {
        this.log.error('[SecretRequest] Failed to get credentials:', error.message);
        this.log.error('[SecretRequest] Devices will remain unavailable until Homebridge is restarted.');
      });
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
      
      // Start secret request if in secret-request mode
      if (this.credentialMode === 'secret-request' && this.secretRequestService) {
        this.secretRequestService.startSecretRequest().catch(error => {
          this.log.error('[SecretRequest] Failed to start request:', error);
        });
      }
    });
    
    // Handle Homebridge shutdown
    this.api.on('shutdown', () => {
      this.cleanup();
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
    this.log.info(`[${accessory.displayName}] Loaded from cache`);
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
        this.log.info(`[${existingAccessory.displayName}] Restoring from cache`);
        
        // Update accessory context
        existingAccessory.context.device = deviceConfig;
        this.api.updatePlatformAccessories([existingAccessory]);

        // Create the accessory handler
        this.createAccessory(existingAccessory, deviceConfig);

      } else {
        // Create new accessory
        this.log.info(`[${deviceConfig.name}] Adding new accessory`);
        
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
      for (const acc of accessoriesToRemove) {
        this.log.info(`[${acc.displayName}] Removing unconfigured accessory`);
      }
      
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

    // Normalize device type from cloud API format (e.g., SMART.TAPOBULB -> light)
    const normalizedType = normalizeDeviceType(config.type);

    // Create new instance based on device type
    switch (normalizedType) {
      case 'light':
        const lightAccessory = new TapoLightAccessory(
          this,
          accessory,
          config,
          this.log,
          this.credentialsReady, // Pass credentials ready state
        );
        this.activeAccessories.set(accessory.UUID, lightAccessory);
        
        // If credentials not ready, add to pending list for later initialization
        if (!this.credentialsReady) {
          this.log.info(`[${config.name}] Device created but waiting for credentials (will show as 'No Response')`);
          this.pendingAccessories.push({ accessory, config });
        }
        break;

      default:
        this.log.warn(`[${config.name}] Unsupported device type: ${config.type} (normalized: ${normalizedType})`);
    }
  }
  
  /**
   * Initialize accessories that were pending credential availability
   */
  private initializePendingAccessories() {
    if (this.pendingAccessories.length === 0) {
      return;
    }
    
    this.log.info(`Initializing ${this.pendingAccessories.length} pending device(s)...`);
    
    const pending = [...this.pendingAccessories];
    this.pendingAccessories = [];
    
    // Initialize existing accessories that were created but not initialized
    for (const { accessory, config } of pending) {
      const existingAccessory = this.activeAccessories.get(accessory.UUID);
      if (existingAccessory) {
        // Call initializeDevice() on the existing accessory instance
        existingAccessory.initializeDevice().catch(err => {
          this.log.error(`[${config.name}] Failed to initialize:`, err);
        });
      }
    }
    
    this.log.info('All devices initialized successfully!');
  }
  
  /**
   * Cleanup when platform is destroyed
   */
  public cleanup() {
    // Cancel any ongoing secret request
    if (this.secretRequestService) {
      this.secretRequestService.cancel().catch(err => {
        this.log.debug('[SecretRequest] Error during cleanup:', err);
      });
      this.secretRequestService.removeAllListeners();
    }
    
    // Clean up all accessories
    for (const accessory of this.activeAccessories.values()) {
      accessory.destroy();
    }
    this.activeAccessories.clear();
  }
}
