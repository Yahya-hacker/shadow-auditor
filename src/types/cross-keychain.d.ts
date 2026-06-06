/**
 * Type declarations for cross-keychain.
 * These provide TypeScript types when the native module isn't installed
 * (e.g., during CI builds or in sandbox environments).
 */
declare module 'cross-keychain' {
  export function deletePassword(service: string, account: string): Promise<boolean>;
  export function getPassword(service: string, account: string): Promise<null | string>;
  export function setPassword(service: string, account: string, password: string): Promise<void>;
}
