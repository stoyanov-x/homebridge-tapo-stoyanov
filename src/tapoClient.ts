/**
 * Tapo Device Client
 * Handles communication with Tapo devices using the KLAP protocol
 * 
 * KLAP Protocol Implementation based on python-kasa library
 * Supports both KLAP v1 and v2 with auto-detection
 * https://github.com/python-kasa/python-kasa
 */

import * as http from 'http';
import * as crypto from 'crypto';
import { TapoDeviceInfo, TapoResponse, TapoCredentials } from './types';

type KLAPVersion = 1 | 2;

interface KLAPSession {
  localSeed: Buffer;
  remoteSeed: Buffer;
  authHash: Buffer;
  key: Buffer;       // AES key (16 bytes)
  iv: Buffer;        // Base IV (12 bytes)
  sig: Buffer;       // Signature key (28 bytes)
  seq: number;       // Sequence number (signed 32-bit)
  timeout: number;   // Session expiry timestamp
  version: KLAPVersion;
}

export class TapoClient {
  private readonly ip: string;
  private readonly credentials: TapoCredentials;
  private readonly port: number = 80;
  private readonly timeout: number = 10000;
  
  private session?: KLAPSession;
  private cookie?: string;
  private klapVersion?: KLAPVersion;  // Remember which version worked

  constructor(ip: string, credentials: TapoCredentials) {
    this.ip = ip;
    this.credentials = credentials;
  }

  /**
   * Make an HTTP POST request using native http module
   */
  private httpPost(path: string, data: Buffer, headers: Record<string, string> = {}): Promise<{ statusCode: number; data: Buffer; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const options: http.RequestOptions = {
        hostname: this.ip,
        port: this.port,
        path: path,
        method: 'POST',
        timeout: this.timeout,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': data.length,
          ...headers,
        },
      };

      const req = http.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            data: Buffer.concat(chunks),
            headers: res.headers,
          });
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.write(data);
      req.end();
    });
  }

  /**
   * Authenticate with the device using KLAP protocol
   * Tries KLAP v1 first, then falls back to v2
   */
  private async authenticate(): Promise<void> {
    // If we already know the version, use it directly
    if (this.klapVersion) {
      await this.authenticateWithVersion(this.klapVersion);
      return;
    }

    // Try KLAP v1 first (most common for Tapo devices)
    try {
      await this.authenticateWithVersion(1);
      this.klapVersion = 1;
      return;
    } catch (error: any) {
      // KLAP v1 failed, try v2
    }

    // Try KLAP v2
    try {
      await this.authenticateWithVersion(2);
      this.klapVersion = 2;
      return;
    } catch (error: any) {
      throw new Error(`Authentication failed with both KLAP v1 and v2: ${error.message}`);
    }
  }

  /**
   * Authenticate with a specific KLAP version
   */
  private async authenticateWithVersion(version: KLAPVersion): Promise<void> {
    // Generate local seed (16 random bytes)
    const localSeed = crypto.randomBytes(16);
    
    // Calculate auth hash based on version
    const authHash = version === 1
      ? this.generateAuthHashV1(this.credentials.email, this.credentials.password)
      : this.generateAuthHashV2(this.credentials.email, this.credentials.password);

    // Step 1: Handshake1 - Send local seed
    let response1;
    try {
      response1 = await this.httpPost('/app/handshake1', localSeed);
    } catch (error: any) {
      throw new Error(`Handshake1 network error: ${error.message}`);
    }

    if (response1.statusCode !== 200) {
      throw new Error(`Handshake1 failed with status ${response1.statusCode}`);
    }

    const handshake1Data = response1.data;
    
    // Response is: remote_seed (16 bytes) + server_hash (32 bytes)
    if (handshake1Data.length !== 48) {
      throw new Error(`Invalid handshake1 response length: ${handshake1Data.length}`);
    }
    
    const remoteSeed = handshake1Data.slice(0, 16);
    const serverHash = handshake1Data.slice(16, 48);
    
    // Get session cookie - parse only the key=value, ignoring attributes
    const setCookie = response1.headers['set-cookie'];
    const rawCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (!rawCookie) {
      throw new Error('No session cookie received from device');
    }
    // Extract just the cookie key=value part (before any semicolons)
    const cookie = rawCookie.split(';')[0].trim();
    this.cookie = cookie;

    // Calculate expected server hash based on version
    const expectedServerHash = version === 1
      ? this.sha256(Buffer.concat([localSeed, authHash]))  // v1: local + auth
      : this.sha256(Buffer.concat([localSeed, remoteSeed, authHash]));  // v2: local + remote + auth
    
    if (!serverHash.equals(expectedServerHash)) {
      throw new Error(`KLAP v${version} server hash verification failed`);
    }

    // Step 2: Handshake2 - Send client hash
    const clientHash = version === 1
      ? this.sha256(Buffer.concat([remoteSeed, authHash]))  // v1: remote + auth
      : this.sha256(Buffer.concat([remoteSeed, localSeed, authHash]));  // v2: remote + local + auth

    let response2;
    try {
      response2 = await this.httpPost('/app/handshake2', clientHash, { 'Cookie': cookie });
    } catch (error: any) {
      throw new Error(`Handshake2 network error: ${error.message}`);
    }

    if (response2.statusCode !== 200) {
      throw new Error(`Handshake2 failed with status: ${response2.statusCode}`);
    }

    // Step 3: Derive session keys (same for both versions)
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
      version,
    };
  }

  /**
   * Generate KLAP v1 auth hash: md5(md5(username) + md5(password))
   */
  private generateAuthHashV1(username: string, password: string): Buffer {
    const usernameHash = crypto.createHash('md5').update(username).digest();
    const passwordHash = crypto.createHash('md5').update(password).digest();
    return crypto.createHash('md5').update(Buffer.concat([usernameHash, passwordHash])).digest();
  }

  /**
   * Generate KLAP v2 auth hash: sha256(sha1(username) + sha1(password))
   */
  private generateAuthHashV2(username: string, password: string): Buffer {
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

    const response = await this.httpPost(`/app/request?seq=${seq}`, encryptedData, {
      'Cookie': this.cookie,
    });

    if (response.statusCode === 403) {
      // Session invalid, clear and retry
      this.session = undefined;
      this.cookie = undefined;
      return this.executeRequest(method, params);
    }

    if (response.statusCode !== 200) {
      throw new Error(`Request failed with status ${response.statusCode}`);
    }

    // Decrypt the response
    const decryptedData = this.decryptResponse(response.data, this.session);
    const result: TapoResponse = JSON.parse(decryptedData);

    if (result.error_code !== 0) {
      throw new Error(`Device returned error: ${result.error_code} - ${result.msg || 'Unknown error'}`);
    }

    return result;
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
    const _signature = data.slice(0, 32);
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
