/**
 * Tapo Cloud Client
 *
 * Communicates with the modern Tapo Cloud Thing API (v2) — the same cloud
 * path the mobile app uses for remote control. This is how we drive the
 * H110 hub's paired IR remotes (no LAN access needed, works fully over the
 * internet).
 *
 * Request chain:
 *   login -> getAppServiceUrlByCloudUserName (signed) -> /v2/auth/app (JWT)
 *   -> /v2/things (find ir.remote sub-thing)
 *   -> /v1/things/{thingName}/services-sync (passthrough)
 *   -> getKeyListInfo / sendIrCmdById
 *
 * The request signature (HMAC-SHA1 over base64(md5(body)) + ts + nonce + path)
 * uses the app's embedded access key/secret — extracted from the APK
 * (r40/C67539a.java), NOT a user secret. Only the account email/password is
 * needed to authenticate.
 *
 * See docs/cloud-thing-api.md and docs/cloud-signature.md for the full details.
 */

import * as crypto from 'crypto';
import * as https from 'https';
import axios, { AxiosInstance } from 'axios';

import { TapoCredentials, TapoThingInfo, TapoIrKey, TapoCloudServiceUrls, TapoPassthroughResponse } from './types';
import {
  CLOUD_LOGIN_URL,
  CLOUD_ACCESS_KEY,
  CLOUD_SECRET,
  CLOUD_APP_NAME,
  CLOUD_APP_VERSION,
  CLOUD_APP_OSPF,
  CLOUD_APP_BRAND,
  CLOUD_SERVICE_IDS,
  CLOUD_REQUEST_TIMEOUT,
} from './constants';

/** Computed request-signing values for a single request */
interface SignedRequest {
  contentMd5: string;   // base64(md5(body))
  timestamp: number;    // epoch seconds
  nonce: string;        // random UUID
  signature: string;    // hex(hmac-sha1(secret, ...))
}

/**
 * Error thrown when the cloud returns a non-zero error_code, or a request fails.
 */
export class TapoCloudError extends Error {
  readonly errorCode?: number;
  readonly status?: number;

  constructor(message: string, options: { errorCode?: number; status?: number } = {}) {
    super(message);
    this.name = 'TapoCloudError';
    this.errorCode = options.errorCode;
    this.status = options.status;
  }
}

export class TapoCloudClient {
  private readonly user: string;
  private readonly password: string;
  private readonly appVersion: string;
  private readonly terminalUUID: string;

  private token = '';
  private appServer = '';
  private security = '';
  private jwt = '';
  private things: TapoThingInfo[] = [];
  private httpInstance?: AxiosInstance;

  constructor(credentials: TapoCredentials, appVersion: string = CLOUD_APP_VERSION) {
    this.user = credentials.email;
    this.password = credentials.password;
    this.appVersion = appVersion;
    this.terminalUUID = crypto.randomUUID();
  }

  /**
   * Shared axios instance for all cloud requests.
   *
   * The Tapo cloud hosts (app-server / security) present certificates that do
   * not chain to public root CAs, so we must disable certificate verification
   * for these hosts — the same `verify=False` the working Python client uses.
   */
  private get http(): AxiosInstance {
    if (!this.httpInstance) {
      this.httpInstance = axios.create({
        timeout: CLOUD_REQUEST_TIMEOUT,
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'User-Agent': 'okhttp/4.9.3',
        },
      });
    }
    return this.httpInstance;
  }

  // ── Auth chain ────────────────────────────────────────────────────────

  /**
   * Step 1: classic TP-Link cloud login -> returns the session token.
   */
  async login(): Promise<string> {
    const res = await this.http.post(CLOUD_LOGIN_URL, {
      method: 'login',
      params: {
        appType: CLOUD_APP_NAME,
        cloudUserName: this.user,
        cloudPassword: this.password,
        terminalUUID: this.terminalUUID,
      },
    });

    const data = res.data as { error_code?: number; result?: { token?: string }; msg?: string };
    if (data.error_code !== 0 || !data.result?.token) {
      throw new TapoCloudError(`Cloud login failed: ${data.msg || `error_code ${data.error_code}`}`, {
        errorCode: data.error_code,
      });
    }

    this.token = data.result.token;
    return this.token;
  }

  /**
   * Sign a request body for the v2 API.
   *
   * signature = hex(hmac_sha1(secret, bodyMd5_b64 + "\n" + ts + "\n" + nonce + "\n" + path))
   * NOTE: the body hash in the signature is base64, NOT hex.
   */
  private sign(body: Buffer, path: string): SignedRequest {
    const bodyMd5 = crypto.createHash('md5').update(body).digest('base64');
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID();
    const message = `${bodyMd5}\n${timestamp}\n${nonce}\n${path}`;
    const signature = crypto.createHmac('sha1', CLOUD_SECRET).update(message).digest('hex');
    return { contentMd5: bodyMd5, timestamp, nonce, signature };
  }

  /**
   * Perform a signed POST to a v2 endpoint (adds Content-MD5 + X-Authorization
   * headers and the app query params).
   */
  private async signedPost(base: string, path: string, bodyObj: Record<string, unknown>): Promise<unknown> {
    const body = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const { contentMd5, timestamp, nonce, signature } = this.sign(body, path);

    const query = new URLSearchParams({
      appName: CLOUD_APP_NAME,
      appVer: this.appVersion,
      termID: this.terminalUUID,
      ospf: CLOUD_APP_OSPF,
      brand: CLOUD_APP_BRAND,
      locale: 'en_US',
      token: this.token,
    });

    const url = `${base}${path}?${query.toString()}`;
    const res = await this.http.post(url, body, {
      headers: {
        'Content-MD5': contentMd5,
        'X-Authorization': `Timestamp=${timestamp}, Nonce=${nonce}, AccessKey=${CLOUD_ACCESS_KEY}, Signature=${signature}`,
      },
    });

    const data = res.data as { error_code?: number; msg?: string };
    if (data.error_code !== 0) {
      throw new TapoCloudError(`Cloud request failed (${path}): ${data.msg || `error_code ${data.error_code}`}`, {
        errorCode: data.error_code,
      });
    }
    return res.data;
  }

  /**
   * Step 2: resolve the region's service URLs (app server, cloud gateway, security).
   */
  async discoverServiceUrls(): Promise<TapoCloudServiceUrls> {
    const data = await this.signedPost(CLOUD_LOGIN_URL, '/api/v2/common/getAppServiceUrlByCloudUserName', {
      cloudUserName: this.user,
      serviceIds: CLOUD_SERVICE_IDS,
    }) as { result?: { serviceList?: Array<{ serviceId: string; serviceUrl: string }> } };

    const services = data.result?.serviceList || [];
    let appServer = '';
    let cloudGateway = '';
    let security = '';

    for (const svc of services) {
      if (svc.serviceId === 'nbu.iot-app-server.app-v2') {
        appServer = svc.serviceUrl;
      } else if (svc.serviceId === 'nbu.iot-cloud-gateway.app-v2') {
        cloudGateway = svc.serviceUrl;
      } else if (svc.serviceId === 'nbu.iot-security.appdevice-v2') {
        security = svc.serviceUrl;
      }
    }

    if (!appServer || !security) {
      throw new TapoCloudError('Could not resolve cloud service URLs (missing app-server or security)');
    }

    this.appServer = appServer;
    this.security = security;
    return { appServer, cloudGateway, security };
  }

  /**
   * Step 3: obtain the app JWT from the security server.
   * The token MUST be prefixed with `ut|`, and the returned JWT is URL-encoded
   * and must be unquoted. (Not required for the REST Thing API — kept for
   * parity with the mobile app flow.)
   */
  async getJwt(): Promise<string> {
    const res = await this.http.post(`${this.security}/v2/auth/app`, {
      appType: CLOUD_APP_NAME,
      terminalUUID: this.terminalUUID,
      token: `ut|${this.token}`,
    });

    const data = res.data as { jwt?: string; error_code?: number; msg?: string };
    if (!data.jwt) {
      throw new TapoCloudError(`JWT auth failed: ${data.msg || `error_code ${data.error_code}`}`, {
        errorCode: data.error_code,
      });
    }

    this.jwt = decodeURIComponent(data.jwt);
    return this.jwt;
  }

  /**
   * Run the full auth chain: login -> service URLs -> JWT.
   */
  async initialize(): Promise<void> {
    await this.login();
    await this.discoverServiceUrls();
    // The JWT is part of the app flow; if it fails it's non-fatal for the
    // REST Thing API we actually use.
    try {
      await this.getJwt();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(`[TapoCloud] JWT fetch failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ── Thing API ─────────────────────────────────────────────────────────

  /**
   * Headers required by the modern Thing API (`/v2/things`, services-sync).
   */
  private thingHeaders(): Record<string, string> {
    return {
      Authorization: `ut|${this.token}`,
      'app-cid': `app:${CLOUD_APP_NAME}:${this.terminalUUID}`,
      'x-app-name': CLOUD_APP_NAME,
      'x-app-version': this.appVersion,
      'x-term-id': this.terminalUUID,
      'x-app-ospf': CLOUD_APP_OSPF,
      'x-app-brand': CLOUD_APP_BRAND,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Step 4: list all things on the account (hubs, lights, IR remotes, ...).
   * Uses the account-region app server.
   */
  async listThings(base?: string): Promise<TapoThingInfo[]> {
    const server = base || this.appServer;
    const query = new URLSearchParams({
      page: '0',
      pageSize: '100',
      includeKasaShareDevices: 'false',
      includePcDevice: 'false',
      includeMatterDevice: 'false',
      includeExternalVendorDeviceInfo: 'false',
    });

    const res = await this.http.get(`${server}/v2/things?${query.toString()}`, {
      headers: this.thingHeaders(),
    });

    const data = res.data as { data?: TapoThingInfo[] };
    this.things = data.data || [];
    return this.things;
  }

  /**
   * Find all IR remote sub-things (category `ir.remote` / `ir_remote`).
   */
  async findIrRemotes(base?: string): Promise<TapoThingInfo[]> {
    const things = this.things.length > 0 ? this.things : await this.listThings(base);
    return things.filter((t) => t.category === 'ir.remote' || t.category === 'ir_remote');
  }

  /**
   * Step 5: send a single request to a thing through the passthrough service.
   * Uses the thing's own region app server when available.
   *
   * If the request fails with an auth error (expired login token / rejected
   * signature), the client re-authenticates and retries once — so a long-running
   * Homebridge stays working past token expiry without a restart.
   */
  private async passthrough(thing: TapoThingInfo, innerRequest: Record<string, unknown>, retried = false): Promise<TapoPassthroughResponse> {
    const server = thing.appServerUrlV2 || this.appServer;
    const body = {
      serviceId: 'passthrough',
      inputParams: {
        requestData: {
          method: 'multipleRequest',
          params: { requests: [innerRequest] },
        },
      },
    };

    let res;
    try {
      res = await this.http.post(`${server}/v1/things/${thing.thingName}/services-sync`, body, {
        headers: this.thingHeaders(),
      });
    } catch (error) {
      if (!retried && this.isAuthError(error)) {
        await this.reauthenticate();
        return this.passthrough(thing, innerRequest, true);
      }
      throw error;
    }

    // The services-sync envelope wraps the payload in outputParams.responseData
    const raw = res.data as {
      requestId?: string;
      error_code?: number;
      outputParams?: { responseData?: TapoPassthroughResponse };
    };
    const responseData = raw.outputParams?.responseData;
    if (raw.error_code !== undefined && raw.error_code !== 0) {
      const err = new TapoCloudError(`Passthrough failed: error_code ${raw.error_code}`, { errorCode: raw.error_code });
      if (!retried && this.isAuthError(err)) {
        await this.reauthenticate();
        return this.passthrough(thing, innerRequest, true);
      }
      throw err;
    }
    if (!responseData) {
      throw new TapoCloudError('Passthrough returned no responseData');
    }
    return responseData;
  }

  /**
   * Heuristic for whether a failure is an auth problem (expired token,
   * rejected signature/access key, 401/403) — the only cases worth a retry.
   */
  private isAuthError(error: unknown): boolean {
    if (error instanceof TapoCloudError) {
      // -10301 signature rejected, -10304 invalid access key
      if (error.errorCode === -10301 || error.errorCode === -10304) {
        return true;
      }
      if (error.status === 401 || error.status === 403) {
        return true;
      }
    }
    // Axios HTTP errors carry response.status
    const withStatus = error as { response?: { status?: number } };
    if (withStatus?.response?.status === 401 || withStatus?.response?.status === 403) {
      return true;
    }
    const msg = error instanceof Error ? error.message : String(error);
    return /token|signature|unauthor|access key|login/i.test(msg);
  }

  /**
   * Refresh the auth chain after an expired token / rejected signature.
   */
  private async reauthenticate(): Promise<void> {
    // eslint-disable-next-line no-console
    console.warn('[TapoCloud] Re-authenticating after auth failure...');
    await this.initialize();
  }

  /**
   * List all IR keys available on the remote (getKeyListInfo).
   */
  async listKeys(thing: TapoThingInfo): Promise<TapoIrKey[]> {
    const resp = await this.passthrough(thing, {
      method: 'getKeyListInfo',
      params: { start_index: 0, sum: 50 },
    });

    const first = resp.result?.responses?.[0];
    if (!first || first.error_code !== 0) {
      throw new TapoCloudError(`getKeyListInfo failed: ${first?.error_code ?? 'no response'}`, {
        errorCode: first?.error_code,
      });
    }
    const keyList = (first.result?.key_list as TapoIrKey[]) || [];
    return keyList;
  }

  /**
   * Fire an IR key on the remote by name (sendIrCmdById).
   */
  async fireKey(thing: TapoThingInfo, keyName: string): Promise<TapoPassthroughResponse> {
    const resp = await this.passthrough(thing, {
      method: 'sendIrCmdById',
      params: { name: keyName },
    });

    const first = resp.result?.responses?.[0];
    if (!first || first.error_code !== 0) {
      throw new TapoCloudError(`sendIrCmdById("${keyName}") failed: ${first?.error_code ?? 'no response'}`, {
        errorCode: first?.error_code,
      });
    }
    return resp;
  }
}
