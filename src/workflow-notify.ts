/**
 * Shared "started in the background" notify text for every `/<name>` command
 * surface (built-ins and saved workflows). One source of truth so the
 * boilerplate cannot drift again — it previously did ("report" vs "result").
 * The result is delivered back into the conversation when the run finishes.
 */
export function backgroundStartedNotify(name: string, runId: string): string {
  return `/${name} running in the background (${runId}) — watch the task panel or /workflows; the result is posted here when it finishes.`;
}
