/**
 * Sleep utility - pause execution for given milliseconds
 */
export const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));
