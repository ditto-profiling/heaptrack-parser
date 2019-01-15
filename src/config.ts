/**
 * The configuration interface.
 */
export interface Config {
  supportedFileVersions: number[];
  newStrings: string[];
  stopStrings: string[];
  maxNumCost: number;
  chunkSize: number;
  maxDataPoints: number;
  chunkCallback: (callback: () => void) => void;
}

/**
 * The configuration.
 */
export const defaultConfig: Config = {
  supportedFileVersions: [1, 2],
  newStrings: [
    'operator new(unsigned long)', 'operator new[](unsigned long)',
    'operator new(unsigned int)', 'operator new[](unsigned int)'
  ],
  stopStrings: [
    'main', '__libc_start_main', '__static_initialization_and_destruction_0'
  ],
  maxNumCost: 20,
  chunkSize: 10000,
  maxDataPoints: 500,
  chunkCallback: (callback: () => void) => callback()
}