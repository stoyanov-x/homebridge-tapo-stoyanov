/**
 * Tapo Device Client
 * Handles communication with Tapo devices using the KLAP protocol
 */

import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import * as CryptoJS from 'crypto-js';
import { TapoDeviceInfo, TapoResponse, TapoCredentials } from './types';

interface KLAPSession {
  localSeed: Buffer;
  remoteSeed?: Buffer;
  userHash?: Buffer;
  sessionKey?: Buffer;
  timeout?: number;
  ivSeq: number;
}

export class TapoClient {
  private readonly ip: string;
  private readonly credentials: TapoCredentials;
  private readonly port: number = 80;
  private readonly timeout: number = 10000;
  
  private httpClient: AxiosInstance;
  private session?: KLAPSession;
  private cookie?: string;

  constructor(ip: string, credentials: TapoCredentials) {
    this.ip = ip;
    this.credentials = credentials;
    
    this.httpClient = axios.create({
      baseURL: `http://${ip}:${this.port}`,
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Authenticate with the device using KLAP protocol
   */
  private async authenticate(): Promise<void> {
    try {
      // Step 1: Handshake1 - Send local seed
      const localSeed = crypto.randomBytes(16);
      const response1 = await this.httpClient.post('/app/handshake1', localSeed, {
        headers: { 'Content-Type': 'application/octet-stream' },
        responseType: 'arraybuffer',
      });

      const remoteSeed = Buffer.from(response1.data);
      const cookie = response1.headers['set-cookie']?.[0];
      
      if (!cookie) {
        throw new Error('No session cookie received from device');
      }
      
      this.cookie = cookie;

      // Step 2: Calculate authentication hash
      const authHash = this.sha256(
        this.sha256(`${this.credentials.email}${this.credentials.password}`)
      );

      // Step 3: Handshake2 - Send authentication
      const localSeedAuthHash = this.sha256(
        Buffer.concat([localSeed, remoteSeed, authHash])
      );

      const response2 = await this.httpClient.post('/app/handshake2', localSeedAuthHash, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Cookie': cookie,
        },
        responseType: 'arraybuffer',
      });

      // Verify remote seed auth hash
      const remoteSeedAuthHash = Buffer.from(response2.data);
      const expectedHash = this.sha256(
        Buffer.concat([remoteSeed, localSeed, authHash])
      );

      if (!remoteSeedAuthHash.equals(expectedHash)) {
        throw new Error('Authentication verification failed');
      }

      // Step 4: Calculate session keys
      const sessionKey = this.sha256(
        Buffer.concat([Buffer.from('lsk'), localSeed, remoteSeed, authHash])
      );

      this.session = {
        localSeed,
        remoteSeed,
        userHash: authHash,
        sessionKey,
        timeout: Date.now() + 86400000, // 24 hours
        ivSeq: 0,
      };

    } catch (error: any) {
      throw new Error(`Authentication failed: ${error.message}`);
    }
  }

  /**
   * Execute a request to the device
   */
  private async executeRequest(method: string, params?: Record<string, any>): Promise<TapoResponse> {
    // Ensure we have a valid session
    if (!this.session || !this.cookie || (this.session.timeout && Date.now() > this.session.timeout)) {
      await this.authenticate();
    }

    if (!this.session || !this.cookie) {
      throw new Error('Failed to establish session with device');
    }

    const request = {
      method,
      params: params || {},
    };

    const requestJson = JSON.stringify(request);
    
    // Encrypt the request
    const { encryptedData, seq } = this.encryptRequest(requestJson, this.session);

    try {
      const response = await this.httpClient.post('/app/request', encryptedData, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Cookie': this.cookie,
        },
        params: { seq },
        responseType: 'arraybuffer',
      });

      // Decrypt the response
      const decryptedData = this.decryptResponse(Buffer.from(response.data), this.session);
      const result: TapoResponse = JSON.parse(decryptedData);

      if (result.error_code !== 0) {
        throw new Error(`Device returned error: ${result.error_code} - ${result.msg || 'Unknown error'}`);
      }

      return result;

    } catch (error: any) {
      // Session might be invalid, clear it and retry once
      if (error.response?.status === 403 && this.session) {
        this.session = undefined;
        this.cookie = undefined;
        return this.executeRequest(method, params);
      }
      throw error;
    }
  }

  /**
   * Get device information
   */
  async getDeviceInfo(): Promise<TapoDeviceInfo> {
    const response = await this.executeRequest('get_device_info');
    return response.result as TapoDeviceInfo;
  }

  /**
   * Set device state (power, brightness, color, etc.)
   */
  async setDeviceInfo(params: Record<string, any>): Promise<void> {
    await this.executeRequest('set_device_info', params);
  }

  /**
   * Turn device on
   */
  async turnOn(): Promise<void> {
    await this.setDeviceInfo({ device_on: true });
  }

  /**
   * Turn device off
   */
  async turnOff(): Promise<void> {
    await this.setDeviceInfo({ device_on: false });
  }

  /**
   * Set brightness (1-100)
   */
  async setBrightness(brightness: number): Promise<void> {
    const value = Math.max(1, Math.min(100, Math.round(brightness)));
    await this.setDeviceInfo({ brightness: value });
  }

  /**
   * Set color temperature in Kelvin (2500-6500)
   */
  async setColorTemperature(kelvin: number): Promise<void> {
    const value = Math.max(2500, Math.min(6500, Math.round(kelvin)));
    await this.setDeviceInfo({
      color_temp: value,
      hue: 0,
      saturation: 0,
    });
  }

  /**
   * Set RGB color using hue and saturation
   */
  async setColor(hue: number, saturation: number): Promise<void> {
    const h = Math.max(0, Math.min(360, Math.round(hue)));
    const s = Math.max(0, Math.min(100, Math.round(saturation)));
    await this.setDeviceInfo({
      hue: h,
      saturation: s,
      color_temp: 0,
    });
  }

  /**
   * Encrypt request data
   */
  private encryptRequest(data: string, session: KLAPSession): { encryptedData: Buffer; seq: number } {
    if (!session.sessionKey) {
      throw new Error('No session key available');
    }

    const seq = session.ivSeq++;
    const iv = this.generateIV(seq, session.sessionKey);
    const cipher = crypto.createCipheriv('aes-128-cbc', session.sessionKey.slice(0, 16), iv);
    
    const encrypted = Buffer.concat([
      cipher.update(data, 'utf8'),
      cipher.final(),
    ]);

    // Add signature
    const signature = this.sha256(
      Buffer.concat([session.sessionKey.slice(0, 16), encrypted])
    );

    return {
      encryptedData: Buffer.concat([signature, encrypted]),
      seq,
    };
  }

  /**
   * Decrypt response data
   */
  private decryptResponse(data: Buffer, session: KLAPSession): string {
    if (!session.sessionKey) {
      throw new Error('No session key available');
    }

    // Extract signature and payload
    const signature = data.slice(0, 32);
    const payload = data.slice(32);

    // Verify signature
    const expectedSignature = this.sha256(
      Buffer.concat([session.sessionKey.slice(0, 16), payload])
    );

    if (!signature.equals(expectedSignature)) {
      throw new Error('Response signature verification failed');
    }

    // Decrypt payload
    const seq = session.ivSeq - 1;
    const iv = this.generateIV(seq, session.sessionKey);
    const decipher = crypto.createDecipheriv('aes-128-cbc', session.sessionKey.slice(0, 16), iv);
    
    const decrypted = Buffer.concat([
      decipher.update(payload),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  }

  /**
   * Generate IV for encryption/decryption
   */
  private generateIV(seq: number, sessionKey: Buffer): Buffer {
    const seqBytes = Buffer.alloc(4);
    seqBytes.writeUInt32LE(seq, 0);
    
    const ivData = Buffer.concat([Buffer.from('iv'), sessionKey, seqBytes]);
    const iv = this.sha256(ivData);
    
    return iv.slice(0, 16);
  }

  /**
   * SHA256 hash helper
   */
  private sha256(data: Buffer | string): Buffer {
    return Buffer.from(
      CryptoJS.SHA256(
        CryptoJS.lib.WordArray.create(
          typeof data === 'string' ? Buffer.from(data) : data
        )
      ).toString(CryptoJS.enc.Hex),
      'hex'
    );
  }

  /**
   * Close the client and cleanup
   */
  async close(): Promise<void> {
    this.session = undefined;
    this.cookie = undefined;
  }
}
