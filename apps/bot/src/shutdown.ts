export interface ShutdownAction {
  readonly resource: string;
  readonly run: () => void | Promise<void>;
}

export interface ShutdownFailure {
  readonly resource: string;
  readonly message: string;
}

export async function runShutdownActions(
  actions: readonly ShutdownAction[],
  onFailure?: (failure: ShutdownFailure, cause: unknown) => void,
): Promise<ShutdownFailure[]> {
  const failures: ShutdownFailure[] = [];
  for (const action of actions) {
    try {
      await action.run();
    } catch (cause) {
      const failure = {
        resource: action.resource,
        message: cause instanceof Error ? cause.message : String(cause),
      };
      failures.push(failure);
      onFailure?.(failure, cause);
    }
  }
  return failures;
}
