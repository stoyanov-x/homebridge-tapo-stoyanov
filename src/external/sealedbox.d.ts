/**
 * Type declarations for tweetnacl-sealedbox-js
 * @see https://github.com/nickolasburr/tweetnacl-sealedbox-js
 */

declare module 'tweetnacl-sealedbox-js' {
  interface SealedBox {
    /**
     * Encrypts a message using the recipient's public key.
     * @param message - The plaintext message bytes
     * @param recipientPublicKey - 32-byte public key
     * @returns Ciphertext (48 bytes overhead: 32-byte ephemeral pubkey + 16-byte auth tag)
     */
    seal(message: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array;

    /**
     * Decrypts a sealed box message.
     * @param ciphertext - The encrypted message
     * @param recipientPublicKey - 32-byte public key
     * @param recipientSecretKey - 32-byte secret key
     * @returns Decrypted plaintext, or null if decryption fails
     */
    open(
      ciphertext: Uint8Array,
      recipientPublicKey: Uint8Array,
      recipientSecretKey: Uint8Array
    ): Uint8Array | null;

    /**
     * Overhead bytes added to sealed box ciphertext (48 bytes)
     */
    overheadLength: number;
  }

  const sealedbox: SealedBox;
  export default sealedbox;
}
