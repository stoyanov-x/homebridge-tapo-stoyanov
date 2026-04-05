"use strict";
/**
 * Secret Request Client for Node.js
 *
 * A TypeScript client for requesting secrets from the secret-request-ios server.
 * Secrets are delivered via iPhone push notification and user approval.
 *
 * This file is intentionally self-contained for easy copy-paste into any
 * Node.js/TypeScript project. Just add `axios`, `tweetnacl`, and `tweetnacl-sealedbox-js`
 * as dependencies.
 *
 * Required environment variable:
 *   SECRET_API_KEY - API key for authentication
 *
 * Optional environment variables:
 *   SECRET_REQUEST_URL - Server URL (default: http://localhost:8420)
 *   SECRET_E2E - Set to "1" for E2E encryption (recommended)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecretRequestClient = exports.SecretRequestError = void 0;
exports.isMultiPartSecret = isMultiPartSecret;
exports.isStringSecret = isStringSecret;
exports.requestSecret = requestSecret;
exports.requestMultiPartSecret = requestMultiPartSecret;
const axios_1 = __importDefault(require("axios"));
const tweetnacl_1 = __importDefault(require("tweetnacl"));
const tweetnacl_sealedbox_js_1 = __importDefault(require("tweetnacl-sealedbox-js"));
// ── Error ──────────────────────────────────────────────────────────────
/** Error thrown when a secret request fails */
class SecretRequestError extends Error {
    code;
    requestId;
    constructor(message, code, requestId) {
        super(message);
        this.code = code;
        this.requestId = requestId;
        this.name = 'SecretRequestError';
    }
}
exports.SecretRequestError = SecretRequestError;
class SecretRequestClient {
    client;
    defaultTimeout;
    requester;
    e2eEnabled;
    /** Per-request keypairs for E2E decryption */
    keypairs = new Map();
    constructor(options = {}) {
        const serverUrl = options.serverUrl || process.env.SECRET_REQUEST_URL || 'http://localhost:8420';
        this.defaultTimeout = options.timeout || 120;
        this.requester = options.requester || 'secret-request';
        this.e2eEnabled = options.e2e ?? (process.env.SECRET_E2E === '1');
        const apiKey = options.apiKey || process.env.SECRET_API_KEY || '';
        if (!apiKey) {
            console.warn('[SecretRequest] WARNING: No API key configured. Set SECRET_API_KEY environment variable.');
        }
        this.client = axios_1.default.create({
            baseURL: serverUrl,
            timeout: (this.defaultTimeout + 10) * 1000,
            headers: apiKey ? { 'X-API-Key': apiKey } : {},
        });
    }
    /**
     * Request a secret from iPhone via push notification.
     * Blocks until the secret is delivered, denied, or times out.
     *
     * If E2E is enabled, the secret is encrypted end-to-end and
     * the server never sees the plaintext.
     */
    async requestSecret(secretName, timeout) {
        const requestTimeout = timeout || this.defaultTimeout;
        const requestId = await this.createRequest(secretName, requestTimeout);
        try {
            return await this.waitForRequest(requestId, requestTimeout);
        }
        catch (error) {
            // Clean up keypair on ANY error since caller can't retry (no requestId exposed)
            // If they call requestSecret() again, a new request+keypair will be created
            this.keypairs.delete(requestId);
            throw error;
        }
    }
    /**
     * Request a secret using the combined /request-sync endpoint.
     * This is more efficient than requestSecret() as it makes a single HTTP call
     * instead of two (create + wait).
     *
     * Ideal for simple CLI usage or one-off requests.
     */
    async requestSecretSync(secretName, timeout) {
        const requestTimeout = timeout || this.defaultTimeout;
        // Generate ephemeral keypair for E2E encryption
        let clientPubkey;
        let keypair;
        if (this.e2eEnabled) {
            keypair = tweetnacl_1.default.box.keyPair();
            clientPubkey = Buffer.from(keypair.publicKey).toString('base64');
        }
        try {
            const response = await this.client.post('/request-sync', {
                secret_name: secretName,
                requester: this.requester,
                timeout: requestTimeout,
                ...(clientPubkey && { client_pubkey: clientPubkey }),
            });
            const data = response.data;
            // Handle encrypted response
            if (data.encrypted && data.ciphertext) {
                if (!keypair) {
                    throw new SecretRequestError('Received encrypted response but no keypair available', 'error');
                }
                // Decrypt the sealed box
                const ciphertext = Buffer.from(data.ciphertext, 'base64');
                const plaintext = tweetnacl_sealedbox_js_1.default.open(ciphertext, keypair.publicKey, keypair.secretKey);
                if (!plaintext) {
                    throw new SecretRequestError('Failed to decrypt secret', 'error');
                }
                // Decode plaintext - could be JSON (multi-part) or plain string
                const decoded = new TextDecoder().decode(plaintext);
                try {
                    // Try parsing as JSON (multi-part secret)
                    const parsed = JSON.parse(decoded);
                    const multiPart = tryParseMultiPartSecret(parsed);
                    if (multiPart) {
                        return multiPart;
                    }
                    // Not a valid multi-part secret, return as plain string
                    return decoded;
                }
                catch {
                    // Invalid JSON, return as plain string secret
                    return decoded;
                }
            }
            // Plaintext response (legacy mode)
            if (data.fields) {
                return data.fields;
            }
            return data.secret_value;
        }
        catch (error) {
            const axiosError = error;
            if (axiosError.response?.status === 408) {
                throw new SecretRequestError('Request timed out', 'timeout');
            }
            if (axiosError.response?.status === 403) {
                throw new SecretRequestError('Request was denied', 'denied');
            }
            if (axiosError.response?.status === 409) {
                throw new SecretRequestError('Request was cancelled', 'cancelled');
            }
            if (axiosError.response?.status === 400) {
                // Protocol error (e.g., E2E encryption mismatch)
                const detail = axiosError.response.data?.detail || 'Bad request';
                throw new SecretRequestError(detail, 'error');
            }
            if (axiosError.response?.status === 422) {
                // Request body validation failure
                const detail = axiosError.response.data?.detail || 'Invalid request body';
                const message = typeof detail === 'string' ? detail : 'Validation error';
                throw new SecretRequestError(`Validation error: ${message}`, 'error');
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new SecretRequestError(`Request failed: ${message}`, 'error');
        }
    }
    /**
     * Create a request without waiting.
     * Use with waitForRequest() and cancelRequest() for manual control.
     */
    async createRequest(secretName, timeout) {
        const requestTimeout = timeout || this.defaultTimeout;
        // Generate ephemeral keypair for E2E encryption
        let clientPubkey;
        if (this.e2eEnabled) {
            const keypair = tweetnacl_1.default.box.keyPair();
            clientPubkey = Buffer.from(keypair.publicKey).toString('base64');
            // Store keypair for later decryption (keyed by pubkey since we don't have request_id yet)
            this.keypairs.set(clientPubkey, keypair);
        }
        try {
            const response = await this.client.post('/request', {
                secret_name: secretName,
                requester: this.requester,
                timeout: requestTimeout,
                ...(clientPubkey && { client_pubkey: clientPubkey }),
            });
            const requestId = response.data.request_id;
            // Re-key the keypair by request_id for easier lookup
            if (clientPubkey && this.keypairs.has(clientPubkey)) {
                const keypair = this.keypairs.get(clientPubkey);
                this.keypairs.delete(clientPubkey);
                this.keypairs.set(requestId, keypair);
            }
            return requestId;
        }
        catch (error) {
            // Cleanup keypair on HTTP error (network failure, 4xx, 5xx, etc.)
            if (clientPubkey) {
                this.keypairs.delete(clientPubkey);
            }
            throw error;
        }
    }
    /**
     * Wait for a previously created request to complete.
     * If the response is encrypted, automatically decrypts it.
     *
     * NOTE: Keypair cleanup strategy for retry support:
     * - Clean up on SUCCESS (response processed)
     * - Clean up on TERMINAL errors (400/403/408/409/422)
     * - KEEP keypair on RETRYABLE errors (connection/network/5xx) to allow retries
     */
    async waitForRequest(requestId, timeout) {
        const requestTimeout = timeout || this.defaultTimeout;
        try {
            const response = await this.client.post(`/request/${requestId}/wait`, null, {
                params: { timeout: requestTimeout },
                timeout: (requestTimeout + 10) * 1000,
            });
            const data = response.data;
            // Handle encrypted response
            if (data.encrypted && data.ciphertext) {
                const keypair = this.keypairs.get(requestId);
                if (!keypair) {
                    // Terminal: Missing keypair (shouldn't happen in normal flow)
                    this.keypairs.delete(requestId);
                    throw new SecretRequestError('Received encrypted response but no keypair available', 'error', requestId);
                }
                // Decrypt the sealed box
                const ciphertext = Buffer.from(data.ciphertext, 'base64');
                const plaintext = tweetnacl_sealedbox_js_1.default.open(ciphertext, keypair.publicKey, keypair.secretKey);
                if (!plaintext) {
                    // Terminal: Decryption failed
                    this.keypairs.delete(requestId);
                    throw new SecretRequestError('Failed to decrypt secret', 'error', requestId);
                }
                // Decode plaintext - could be JSON (multi-part) or plain string
                const decoded = new TextDecoder().decode(plaintext);
                try {
                    // Try parsing as JSON (multi-part secret)
                    const parsed = JSON.parse(decoded);
                    const multiPart = tryParseMultiPartSecret(parsed);
                    if (multiPart) {
                        // Success - clean up keypair
                        this.keypairs.delete(requestId);
                        return multiPart;
                    }
                    // Not a valid multi-part secret, return as plain string
                    // Success - clean up keypair
                    this.keypairs.delete(requestId);
                    return decoded;
                }
                catch {
                    // Plain string secret
                    // Success - clean up keypair
                    this.keypairs.delete(requestId);
                    return decoded;
                }
            }
            // Plaintext response (legacy mode)
            const result = data.fields ? data.fields : data.secret_value;
            // Success - clean up keypair
            this.keypairs.delete(requestId);
            return result;
        }
        catch (error) {
            const axiosError = error;
            // Clean up keypair for terminal states only
            const status = axiosError.response?.status;
            if (status && [400, 403, 408, 409, 422].includes(status)) {
                this.keypairs.delete(requestId);
            }
            // else: retryable error (connection/network/5xx) - keep keypair for retry
            if (status === 408) {
                throw new SecretRequestError('Request timed out', 'timeout', requestId);
            }
            if (status === 403) {
                throw new SecretRequestError('Request was denied', 'denied', requestId);
            }
            if (status === 409) {
                throw new SecretRequestError('Request was cancelled', 'cancelled', requestId);
            }
            if (status === 400) {
                // Protocol error (e.g., E2E encryption mismatch)
                const detail = axiosError.response?.data?.detail || 'Bad request';
                throw new SecretRequestError(detail, 'error', requestId);
            }
            if (status === 422) {
                // Request body validation failure
                const detail = axiosError.response?.data?.detail || 'Invalid request body';
                const message = typeof detail === 'string' ? detail : 'Validation error';
                throw new SecretRequestError(`Validation error: ${message}`, 'error', requestId);
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new SecretRequestError(`Request failed: ${message}`, 'error', requestId);
        }
    }
    /**
     * Cancel a pending request.
     * Cleans up the associated keypair to prevent memory leaks.
     */
    async cancelRequest(requestId) {
        await this.client.delete(`/request/${requestId}`);
        // Clean up any stored keypair for this request
        this.keypairs.delete(requestId);
    }
    /**
     * Get the status of a request.
     */
    async getStatus(requestId) {
        const response = await this.client.get(`/request/${requestId}`);
        return response.data;
    }
    /**
     * Check if the server is healthy.
     */
    async healthCheck() {
        try {
            const response = await this.client.get('/health', { timeout: 5000 });
            return response.status === 200;
        }
        catch {
            return false;
        }
    }
}
exports.SecretRequestClient = SecretRequestClient;
// ── Type Guards ────────────────────────────────────────────────────────
/** Type guard: check if a secret value is multi-part */
function isMultiPartSecret(value) {
    return typeof value === 'object' && value !== null;
}
/** Type guard: check if a secret value is a simple string */
function isStringSecret(value) {
    return typeof value === 'string';
}
/**
 * Validate and parse JSON as MultiPartSecret.
 * Returns the parsed object if it's a plain object with all string values,
 * otherwise returns undefined.
 */
function tryParseMultiPartSecret(parsed) {
    if (parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        Object.values(parsed).every((v) => typeof v === 'string')) {
        return parsed;
    }
    return undefined;
}
// ── Convenience Functions ──────────────────────────────────────────────
/** Request a secret (creates a one-shot client) */
async function requestSecret(secretName, options = {}) {
    const client = new SecretRequestClient(options);
    return client.requestSecret(secretName, options.timeout);
}
/** Request a multi-part secret with type assertion */
async function requestMultiPartSecret(secretName, options = {}) {
    const result = await requestSecret(secretName, options);
    if (typeof result === 'string') {
        throw new SecretRequestError(`Expected multi-part secret but got single value for '${secretName}'`, 'error');
    }
    return result;
}
// ── Usage Examples ─────────────────────────────────────────────────────
//
// Basic:
//   const secret = await requestSecret('my-secret', { apiKey: 'sk_live_...' });
//
// With E2E encryption (recommended):
//   const secret = await requestSecret('my-secret', {
//     apiKey: 'sk_live_...',
//     e2e: true,
//   });
//
// Using requestSecretSync (single HTTP call):
//   const client = new SecretRequestClient({ apiKey: 'sk_live_...', e2e: true });
//   const secret = await client.requestSecretSync('my-secret');
//
// With cancellation:
//   const client = new SecretRequestClient({ apiKey: 'sk_live_...' });
//   const requestId = await client.createRequest('my-secret');
//
//   process.on('SIGINT', async () => {
//     await client.cancelRequest(requestId);
//     process.exit(130);
//   });
//
//   const secret = await client.waitForRequest(requestId);
exports.default = SecretRequestClient;
//# sourceMappingURL=secret-client.js.map