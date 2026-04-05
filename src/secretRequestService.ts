/**
 * Secret Request Service
 * 
 * Orchestrates background secret requests for Tapo credentials.
 * Handles timeout, retry logic, and state management.
 */

import { Logger } from 'homebridge';
import { EventEmitter } from 'events';
import { 
  SecretRequestClient, 
  SecretRequestError, 
  SecretValue,
  isMultiPartSecret 
} from './external/secret-client';
import { TapoCredentials, SecretRequestState, SecretRequestStatus } from './types';

export interface SecretRequestServiceConfig {
  secretName: string;
  serverUrl?: string;
  timeoutSeconds?: number;
  apiKey?: string;
}

/**
 * Events emitted by SecretRequestService:
 * - stateChange: (state: SecretRequestState) => void
 * - credentialsReceived: (credentials: TapoCredentials) => void
 * - requestFailed: (error: Error) => void
 */
export class SecretRequestService extends EventEmitter {
  private client: SecretRequestClient;
  private config: SecretRequestServiceConfig;
  private log: Logger;
  
  private state: SecretRequestState = 'idle';
  private requestStartTime?: Date;
  private errorMessage?: string;
  private requestId?: string;
  private abortController?: AbortController;

  constructor(config: SecretRequestServiceConfig, log: Logger) {
    super();
    this.config = config;
    this.log = log;

    // Initialize Secret Request client with E2E encryption enabled
    this.client = new SecretRequestClient({
      serverUrl: config.serverUrl || 'http://localhost:8420',
      timeout: config.timeoutSeconds || 43200, // 12 hours default
      requester: 'homebridge-tapo',
      apiKey: config.apiKey,
      e2e: true, // Always use E2E encryption for security
    });
  }

  /**
   * Get current status
   */
  getStatus(): SecretRequestStatus {
    return {
      state: this.state,
      requestStartTime: this.requestStartTime,
      timeoutSeconds: this.config.timeoutSeconds,
      errorMessage: this.errorMessage,
      requestId: this.requestId,
    };
  }

  /**
   * Start requesting secret from iPhone
   * Returns immediately but continues in background
   */
  async startSecretRequest(): Promise<void> {
    if (this.state === 'requesting') {
      this.log.warn('[SecretRequest] Request already in progress');
      return;
    }

    this.setState('requesting');
    this.requestStartTime = new Date();
    this.errorMessage = undefined;
    this.requestId = undefined;

    const timeoutHours = Math.floor((this.config.timeoutSeconds || 43200) / 3600);
    const timeoutMins = Math.floor(((this.config.timeoutSeconds || 43200) % 3600) / 60);
    
    this.log.info(`[SecretRequest] Requesting credentials '${this.config.secretName}' from iPhone...`);
    this.log.info(`[SecretRequest] Please approve the secret request on your iPhone (timeout: ${timeoutHours}h ${timeoutMins}m)`);

    // Run the request in background
    this.executeRequest().catch(error => {
      // Error already handled in executeRequest, this is just to prevent unhandled promise rejection
      this.log.debug('[SecretRequest] Request promise rejected:', error.message);
    });
  }

  /**
   * Execute the secret request with retry logic
   */
  private async executeRequest(): Promise<void> {
    try {
      // First, check if secret server is available
      this.log.debug('[SecretRequest] Checking server health...');
      const healthy = await this.client.healthCheck();
      
      if (!healthy) {
        this.log.warn('[SecretRequest] Secret server not available at ' + (this.config.serverUrl || 'http://localhost:8420'));
        this.log.warn('[SecretRequest] Will retry health check every 30 seconds...');
        
        // Retry health check with exponential backoff
        const maxHealthCheckRetries = 10; // 10 retries over ~5 minutes
        for (let i = 0; i < maxHealthCheckRetries; i++) {
          await this.sleep(30000); // Wait 30 seconds
          
          if (this.state !== 'requesting') {
            // Request was cancelled
            return;
          }
          
          this.log.debug(`[SecretRequest] Health check retry ${i + 1}/${maxHealthCheckRetries}...`);
          const isHealthy = await this.client.healthCheck();
          
          if (isHealthy) {
            this.log.info('[SecretRequest] Secret server is now available!');
            break;
          }
          
          if (i === maxHealthCheckRetries - 1) {
            throw new Error('Secret server unavailable after multiple retries. Please check server is running.');
          }
        }
      } else {
        this.log.debug('[SecretRequest] Server health check passed');
      }

      // Start periodic "still waiting" messages
      this.startWaitingMessages();

      // Request the secret (this will block until delivered/denied/timeout)
      this.log.debug('[SecretRequest] Sending secret request...');
      const secret = await this.client.requestSecretSync(
        this.config.secretName,
        this.config.timeoutSeconds,
      );

      // Parse the secret into credentials
      const credentials = this.parseSecret(secret);
      
      if (!credentials) {
        throw new Error('Failed to parse credentials from secret. Expected email/password fields.');
      }

      this.log.info('[SecretRequest] Secret received successfully!');
      this.setState('delivered');
      
      // Emit credentials to platform
      this.emit('credentialsReceived', credentials);

    } catch (error) {
      this.handleRequestError(error);
    }
  }

  /**
   * Parse secret value into TapoCredentials
   */
  private parseSecret(secret: SecretValue): TapoCredentials | null {
    // Multi-part secret (preferred format)
    if (isMultiPartSecret(secret)) {
      // Try common field name variations
      const email = secret.email || secret.username || secret.user || '';
      const password = secret.password || secret.pass || '';
      
      if (!email || !password) {
        this.log.warn('[SecretRequest] Multi-part secret missing email or password field');
        this.log.warn('[SecretRequest] Available fields:', Object.keys(secret).join(', '));
        return null;
      }
      
      return { email, password };
    }
    
    // Single string secret - try to parse as "email:password"
    if (typeof secret === 'string') {
      const parts = secret.split(':');
      if (parts.length === 2) {
        return {
          email: parts[0].trim(),
          password: parts[1].trim(),
        };
      }
      
      this.log.warn('[SecretRequest] Expected multi-part secret or "email:password" format');
      return null;
    }
    
    return null;
  }

  /**
   * Handle request errors
   */
  private handleRequestError(error: unknown): void {
    if (error instanceof SecretRequestError) {
      switch (error.code) {
        case 'timeout':
          this.log.error('[SecretRequest] Request timed out. No response from iPhone.');
          this.log.error('[SecretRequest] Make sure your iPhone is connected and ntfy notifications are enabled.');
          this.log.error('[SecretRequest] Devices will remain unavailable until Homebridge is restarted and secret is approved.');
          this.errorMessage = 'Request timed out';
          this.setState('timeout');
          break;
          
        case 'denied':
          this.log.error('[SecretRequest] Request was denied on iPhone.');
          this.log.error('[SecretRequest] Please restart Homebridge to create a new request.');
          this.errorMessage = 'Request denied by user';
          this.setState('denied');
          break;
          
        case 'cancelled':
          this.log.warn('[SecretRequest] Request was cancelled.');
          this.errorMessage = 'Request cancelled';
          this.setState('error');
          break;
          
        default:
          this.log.error('[SecretRequest] Request failed:', error.message);
          this.errorMessage = error.message;
          this.setState('error');
      }
    } else if (error instanceof Error) {
      this.log.error('[SecretRequest] Unexpected error:', error.message);
      this.log.debug('[SecretRequest] Error stack:', error.stack);
      this.errorMessage = error.message;
      this.setState('error');
    } else {
      this.log.error('[SecretRequest] Unknown error:', String(error));
      this.errorMessage = String(error);
      this.setState('error');
    }
    
    this.emit('requestFailed', error instanceof Error ? error : new Error(String(error)));
  }

  /**
   * Update state and emit event
   */
  private setState(newState: SecretRequestState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.emit('stateChange', newState);
    }
  }

  /**
   * Start periodic "still waiting" log messages
   */
  private startWaitingMessages(): void {
    const interval = setInterval(() => {
      if (this.state !== 'requesting' || !this.requestStartTime) {
        clearInterval(interval);
        return;
      }
      
      const elapsed = Date.now() - this.requestStartTime.getTime();
      const remaining = ((this.config.timeoutSeconds || 43200) * 1000) - elapsed;
      
      if (remaining <= 0) {
        clearInterval(interval);
        return;
      }
      
      const remainingMinutes = Math.floor(remaining / 60000);
      const remainingHours = Math.floor(remainingMinutes / 60);
      const mins = remainingMinutes % 60;
      
      if (remainingHours > 0) {
        this.log.info(`[SecretRequest] Still waiting for approval... (${remainingHours}h ${mins}m remaining)`);
      } else {
        this.log.info(`[SecretRequest] Still waiting for approval... (${mins} minutes remaining)`);
      }
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  /**
   * Cancel ongoing request
   */
  async cancel(): Promise<void> {
    if (this.state !== 'requesting') {
      return;
    }
    
    this.log.info('[SecretRequest] Cancelling request...');
    
    if (this.requestId) {
      try {
        await this.client.cancelRequest(this.requestId);
      } catch (error) {
        this.log.debug('[SecretRequest] Error cancelling request:', error);
      }
    }
    
    this.setState('idle');
    this.requestId = undefined;
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
