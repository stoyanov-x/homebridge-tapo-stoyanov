/**
 * Tapo Device Client
 * Handles communication with Tapo devices using the KLAP protocol
 * 
 * KLAP v2 Protocol Implementation based on python-kasa library
 * https://github.com/python-kasa/python-kasa
 */

import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import { TapoDeviceInfo, TapoResponse, TapoCredentials } from './types';

interface KLAPSession {
  localSeed: Buffer;
  remoteSeed: Buffer;
  authHash: Buffer;
  key: Buffer;       // AES key (16 bytes)
  iv: Buffer;        // Base IV (12 bytes)
  sig: Buffer;       // Signature key (28 bytes)
  seq: number;       // Sequence number (signed 32-bit)
  timeout: number;   // Session expiry timestamp
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
   * Authenticate with the device using KLAP v2 protocol
   */
  private async authenticate(): Promise<void> {
    try {
      // Generate local seed (16 random bytes)
      const localSeed = crypto.randomBytes(16);
      
      // Calculate auth hash: sha256(sha1(username) + sha1(password))
      const authHash = this.generateAuthHash(
        this.credentials.email,
        this.credentials.password
      );

      // Step 1: Handshake1 - Send local seed
      const response1 = await this.httpClient.post('/app/handshake1', localSeed, {
        headers: { 'Content-Type': 'application/octet-stream' },
        responseType: 'arraybuffer',
      });

      const handshake1Data = Buffer.from(response1.data);
      
      // Response is: remote_seed (16 bytes) + server_hash (32 bytes)
      if (handshake1Data.length !== 48) {
        throw new Error(`Invalid handshake1 response length: ${handshake1Data.length}`);
      }
      
      const remoteSeed = handshake1Data.slice(0, 16);
      const serverHash = handshake1Data.slice(16, 48);
      
      const cookie = response1.headers['set-cookie']?.[0];
      if (!cookie) {
        throw new Error('No session cookie received from device');
      }
      this.cookie = cookie;

      // Verify server hash: sha256(local_seed + remote_seed + auth_hash) - KLAP v2
      const expectedServerHash = this.sha256(
        Buffer.concat([localSeed, remoteSeed, authHash])
      );
      
      if (!serverHash.equals(expectedServerHash)) {
        throw new Error('Server hash verification failed - invalid credentials');
      }

      // Step 2: Handshake2 - Send client hash: sha256(remote_seed + local_seed + auth_hash) - KLAP v2
      const clientHash = this.sha256(
        Buffer.concat([remoteSeed, localSeed, authHash])
      );

      const response2 = await this.httpClient.post('/app/handshake2', clientHash, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Cookie': cookie,
        },
        responseType: 'arraybuffer',
      });

      if (response2.status !== 200) {
        throw new Error(`Handshake2 failed with status: ${response2.status}`);
      }

      // Step 3: Derive session keys
      // Key: sha256("lsk" + local_seed + remote_seed + auth_hash)[:16]
      const keyPayload = Buffer.concat([Buffer.from('lsk'), localSeed, remoteSeed, authHash]);
      const key = this.sha256(keyPayload).slice(0, 16);
      
      // IV: sha256("iv" + local_seed + remote_seed + auth_hash)
      // First 12 bytes are base IV, last 4 bytes are initial seq (signed big-endian)
      const ivPayload = Buffer.concat([Buffer.from('iv'), localSeed, remoteSeed, authHash]);
      const fullIv = this.sha256(ivPayload);
      const iv = fullIv.slice(0, 12);
      const seq = fullIv.readInt32BE(28);
      
      // Signature key: sha256("ldk" + local_seed + remote_seed + auth_hash)[:28]
      const sigPayload = Buffer.concat([Buffer.from('ldk'), localSeed, remoteSeed, authHash]);
      const sig = this.sha256(sigPayload).slice(0, 28);

      this.session = {
        localSeed,
        remoteSeed,
        authHash,
        key,
        iv,
        sig,
        seq,
        timeout: Date.now() + 86400000, // 24 hours
      };

    } catch (error: any) {
      throw new Error(`Authentication failed: ${error.message}`);
    }
  }

  /**
   * Generate KLAP v2 auth hash: sha256(sha1(username) + sha1(password))
   */
  private generateAuthHash(username: string, password: string): Buffer {
    const usernameHash = crypto.createHash('sha1').update(username).digest();
    const passwordHash = crypto.createHash('sha1').update(password).digest();
    return this.sha256(Buffer.concat([usernameHash, passwordHash]));
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
   * Encrypt request data using KLAP v2 encryption
   */
  private encryptRequest(data: string, session: KLAPSession): { encryptedData: Buffer; seq: number } {
    // Increment sequence number
    session.seq += 1;
    const seq = session.seq;
    
    // Generate full IV: base_iv (12 bytes) + seq (4 bytes, signed big-endian)
    const seqBytes = Buffer.alloc(4);
    seqBytes.writeInt32BE(seq, 0);
    const iv = Buffer.concat([session.iv, seqBytes]);
    
    // Encrypt with AES-128-CBC and PKCS7 padding
    const cipher = crypto.createCipheriv('aes-128-cbc', session.key, iv);
    const dataBuffer = Buffer.from(data, 'utf8');
    
    const encrypted = Buffer.concat([
      cipher.update(dataBuffer),
      cipher.final(),
    ]);

    // Generate signature: sha256(sig_key + seq + ciphertext)
    const signature = this.sha256(
      Buffer.concat([session.sig, seqBytes, encrypted])
    );

    return {
      encryptedData: Buffer.concat([signature, encrypted]),
      seq,
    };
  }

  /**
   * Decrypt response data using KLAP v2 decryption
   */
  private decryptResponse(data: Buffer, session: KLAPSession): string {
    // Extract signature (32 bytes) and ciphertext
    const signature = data.slice(0, 32);
    const ciphertext = data.slice(32);
    
    // Generate full IV for current seq
    const seqBytes = Buffer.alloc(4);
    seqBytes.writeInt32BE(session.seq, 0);
    const iv = Buffer.concat([session.iv, seqBytes]);
    
    // Decrypt with AES-128-CBC
    const decipher = crypto.createDecipheriv('aes-128-cbc', session.key, iv);
    
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  }

  /**
   * SHA256 hash helper using Node.js crypto
   */
  private sha256(data: Buffer | string): Buffer {
    const hash = crypto.createHash('sha256');
    hash.update(typeof data === 'string' ? Buffer.from(data) : data);
    return hash.digest();
  }

  /**
   * Close the client and cleanup
   */
  async close(): Promise<void> {
    this.session = undefined;
    this.cookie = undefined;
  }
}
