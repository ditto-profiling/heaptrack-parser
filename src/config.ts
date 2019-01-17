/**
 * The configuration interface.
 */
export interface Config {
  maxNumCost: number;
  maxDataPoints: number;
}

/**
 * The configuration.
 */
export const defaultConfig: Config = {
  maxNumCost: 20,
  maxDataPoints: 500
}