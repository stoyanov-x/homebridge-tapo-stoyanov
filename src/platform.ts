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
import { IrRemoteAccessory } from './irRemoteAccessory';
import { TapoCloudClient } from './tapoCloudClient';
import { TapoPlatformConfig, TapoDeviceConfig, TapoCredentials, TapoThingInfo, TapoAccessory } from './types';
import { getDecryptedCredentials, normalizeDeviceType, decodeBase64Label, decryptCredential } from './utils';
import { SecretRequestService } from './secretRequestService';

export class TapoPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // Track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];
  
  // Track active accessory instances
  private readonly activeAccessories: Map<string, TapoAccessory> = new Map();
  
  public readonly config: TapoPlatformConfig;
  public credentials: TapoCredentials;
  private credentialMode: 'traditional' | 'secret-request';
  private secretRequestService?: SecretRequestService;
  private credentialsReady = false;
  private pendingAccessories: Array<{ accessory: PlatformAccessory; config: TapoDeviceConfig }> = [];
  private pendingIrConfigs: TapoDeviceConfig[] = [];

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
    const irConfigs: TapoDeviceConfig[] = [];

    // Register each device from config
    for (const deviceConfig of this.config.devices) {
      // IR remotes are cloud sub-things (no LAN access) — handle them separately
      if (normalizeDeviceType(deviceConfig.type) === 'ir-remote') {
        configuredDevices.add(this.api.hap.uuid.generate(this.deviceId(deviceConfig)));
        irConfigs.push(deviceConfig);
        continue;
      }

      // Generate a unique id for the accessory
      const uuid = this.api.hap.uuid.generate(this.deviceId(deviceConfig));
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

    // Kick off cloud-based IR remote discovery for any configured IR remotes
    if (irConfigs.length > 0) {
      this.initializeIrRemotes(irConfigs);
    }
  }

  /**
   * Stable identifier for a device config (used for the accessory UUID).
   * Prefers the cloud thingName, then the local IP, then the display name.
   */
  private deviceId(config: TapoDeviceConfig): string {
    return config.thingName || config.ip || config.name;
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
      case 'light': {
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
      }

      default:
        this.log.warn(`[${config.name}] Unsupported device type: ${config.type} (normalized: ${normalizedType})`);
    }
  }

  /**
   * Discover configured IR remotes via the Tapo Cloud Thing API and create
   * their Television accessories. IR remotes are cloud sub-things of the
   * H110 hub — they have no local IP, so this is entirely cloud-based.
   */
  private async initializeIrRemotes(irConfigs: TapoDeviceConfig[]) {
    if (irConfigs.length === 0) {
      return;
    }

    // Defer until credentials are available (e.g. Secret Request mode)
    if (!this.credentialsReady) {
      this.log.info(`[IR Remote] Queuing ${irConfigs.length} IR remote(s) until credentials are available`);
      this.pendingIrConfigs = irConfigs;
      return;
    }

    this.log.info(`[IR Remote] Discovering ${irConfigs.length} IR remote(s) via cloud...`);

    try {
      // Full cloud chain: login -> service URLs -> JWT -> list things
      const client = new TapoCloudClient(this.credentials);
      await client.initialize();

      const remotes = await client.findIrRemotes();
      if (remotes.length === 0) {
        this.log.warn('[IR Remote] No IR remotes found on this TP-Link account');
        return;
      }

      this.log.info(`[IR Remote] Found ${remotes.length} IR remote(s) on the account`);

      for (const irConfig of irConfigs) {
        const thing = this.matchIrRemote(irConfig, remotes);
        if (!thing) {
          this.log.warn(
            `[IR Remote] "${irConfig.name}" not found on the account. ` +
            `Known remotes: ${remotes.map(r => `"${decodeBase64Label(r.nickname)}" (${r.thingName})`).join(', ')}`,
          );
          continue;
        }
        this.createIrAccessory(irConfig, thing, client);
      }
    } catch (error) {
      this.log.error('[IR Remote] Cloud discovery failed:', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Match a configured IR remote to a cloud thing by thingName or decoded nickname.
   */
  private matchIrRemote(config: TapoDeviceConfig, remotes: TapoThingInfo[]): TapoThingInfo | undefined {
    if (config.thingName) {
      return remotes.find((r) => r.thingName === config.thingName);
    }
    return remotes.find((r) => decodeBase64Label(r.nickname) === config.name);
  }

  /**
   * Create (or restore) the Television accessory for an IR remote.
   */
  private createIrAccessory(config: TapoDeviceConfig, thing: TapoThingInfo, client: TapoCloudClient) {
    const uuid = this.api.hap.uuid.generate(this.deviceId(config));
    const existingAccessory = this.accessories.find((accessory) => accessory.UUID === uuid);

    if (existingAccessory) {
      this.log.info(`[${existingAccessory.displayName}] Restoring IR remote from cache`);
      existingAccessory.context.device = config;
      existingAccessory.context.thing = thing;
      this.api.updatePlatformAccessories([existingAccessory]);
      this.createIrRemoteHandler(existingAccessory, config, thing, client);
    } else {
      this.log.info(`[${config.name}] Adding IR remote accessory`);
      const accessory = new this.api.platformAccessory(config.name, uuid);
      accessory.context.device = config;
      accessory.context.thing = thing;
      this.createIrRemoteHandler(accessory, config, thing, client);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }

  /**
   * Create the IrRemoteAccessory handler instance.
   */
  private createIrRemoteHandler(accessory: PlatformAccessory, config: TapoDeviceConfig, thing: TapoThingInfo, client: TapoCloudClient) {
    // Remove old instance if it exists
    const oldInstance = this.activeAccessories.get(accessory.UUID);
    if (oldInstance) {
      oldInstance.destroy();
    }

    const irRemote = new IrRemoteAccessory(
      this,
      accessory,
      config,
      thing,
      client,
      this.log,
    );
    this.activeAccessories.set(accessory.UUID, irRemote);

    // Fetch keys and build input sources
    irRemote.initializeDevice().catch((error) => {
      this.log.error(`[${config.name}] Failed to initialize IR remote:`, error instanceof Error ? error.message : String(error));
    });
  }
  
  /**
   * Initialize accessories that were pending credential availability
   */
  private initializePendingAccessories() {
    const hadPending = this.pendingAccessories.length > 0 || this.pendingIrConfigs.length > 0;
    if (!hadPending) {
      return;
    }
    
    this.log.info(`Initializing ${this.pendingAccessories.length + this.pendingIrConfigs.length} pending device(s)...`);
    
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

    // Kick off cloud-based IR remote discovery for queued IR remotes
    if (this.pendingIrConfigs.length > 0) {
      const irConfigs = [...this.pendingIrConfigs];
      this.pendingIrConfigs = [];
      this.initializeIrRemotes(irConfigs);
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
