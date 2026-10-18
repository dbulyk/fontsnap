/** The message of anything that was thrown or rejected (not everything thrown is an Error). */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
