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
export interface SecretRequestOptions {
    serverUrl?: string;
    timeout?: number;
    requester?: string;
    apiKey?: string;
    /** Enable E2E encryption. Server never sees plaintext. */
    e2e?: boolean;
}
export interface RequestStatus {
    request_id: string;
    status: 'pending' | 'notified' | 'delivered' | 'expired' | 'denied' | 'cancelled' | 'error';
    secret_name: string;
    created_at: string;
    expires_at: string;
    error_message?: string;
    /** Encryption mode if E2E enabled */
    encryption?: string;
}
export interface SecretResponse {
    secret_name: string;
    secret_value: string | null;
    fields: Record<string, string> | null;
    /** Base64-encoded ciphertext (E2E mode) */
    ciphertext: string | null;
    /** True if response is E2E encrypted */
    encrypted: boolean;
    delivered_at: string;
}
/** Type for multi-part credentials (key-value pairs) */
export type MultiPartSecret = Record<string, string>;
/** A secret can be a single string value or multi-part key-value pairs */
export type SecretValue = string | MultiPartSecret;
/** Error thrown when a secret request fails */
export declare class SecretRequestError extends Error {
    readonly code: 'timeout' | 'denied' | 'cancelled' | 'error';
    readonly requestId?: string | undefined;
    constructor(message: string, code: 'timeout' | 'denied' | 'cancelled' | 'error', requestId?: string | undefined);
}
export declare class SecretRequestClient {
    private client;
    private defaultTimeout;
    private requester;
    private e2eEnabled;
    /** Per-request keypairs for E2E decryption */
    private keypairs;
    constructor(options?: SecretRequestOptions);
    /**
     * Request a secret from iPhone via push notification.
     * Blocks until the secret is delivered, denied, or times out.
     *
     * If E2E is enabled, the secret is encrypted end-to-end and
     * the server never sees the plaintext.
     */
    requestSecret(secretName: string, timeout?: number): Promise<SecretValue>;
    /**
     * Request a secret using the combined /request-sync endpoint.
     * This is more efficient than requestSecret() as it makes a single HTTP call
     * instead of two (create + wait).
     *
     * Ideal for simple CLI usage or one-off requests.
     */
    requestSecretSync(secretName: string, timeout?: number): Promise<SecretValue>;
    /**
     * Create a request without waiting.
     * Use with waitForRequest() and cancelRequest() for manual control.
     */
    createRequest(secretName: string, timeout?: number): Promise<string>;
    /**
     * Wait for a previously created request to complete.
     * If the response is encrypted, automatically decrypts it.
     *
     * NOTE: Keypair cleanup strategy for retry support:
     * - Clean up on SUCCESS (response processed)
     * - Clean up on TERMINAL errors (400/403/408/409/422)
     * - KEEP keypair on RETRYABLE errors (connection/network/5xx) to allow retries
     */
    waitForRequest(requestId: string, timeout?: number): Promise<SecretValue>;
    /**
     * Cancel a pending request.
     * Cleans up the associated keypair to prevent memory leaks.
     */
    cancelRequest(requestId: string): Promise<void>;
    /**
     * Get the status of a request.
     */
    getStatus(requestId: string): Promise<RequestStatus>;
    /**
     * Check if the server is healthy.
     */
    healthCheck(): Promise<boolean>;
}
/** Type guard: check if a secret value is multi-part */
export declare function isMultiPartSecret(value: SecretValue): value is MultiPartSecret;
/** Type guard: check if a secret value is a simple string */
export declare function isStringSecret(value: SecretValue): value is string;
/** Request a secret (creates a one-shot client) */
export declare function requestSecret(secretName: string, options?: SecretRequestOptions): Promise<SecretValue>;
/** Request a multi-part secret with type assertion */
export declare function requestMultiPartSecret(secretName: string, options?: SecretRequestOptions): Promise<MultiPartSecret>;
export default SecretRequestClient;
//# sourceMappingURL=secret-client.d.ts.map