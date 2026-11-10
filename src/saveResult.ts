// Save-outcome classification for `save_app_config`, kept free of DOM/tauri so it can be tested.

/**
 * How a save ended. "saved": on disk. "memory-only": the backend runs on it but
 * the file write failed. "refused": like memory-only, but the unreadable-config
 * guard refuses every save until a restart loads the file (or the file is gone).
 */
export type SaveResult = "saved" | "memory-only" | "refused";

/** The `kind` the backend tags a rejected `save_app_config` invoke with. */
const KIND_TO_RESULT = {
  loadRefused: "refused",
  writeFailed: "memory-only",
} as const;

/**
 * Turn whatever a failed `save_app_config` invoke threw into the result to report
 * and the message to log. A structured error carries the backend's own text; an
 * IPC failure before the command ran (a plain string, an `Error`) is memory-only.
 */
export function classifySaveError(e: unknown): {
  result: Exclude<SaveResult, "saved">;
  message: string;
} {
  if (e && typeof e === "object" && "kind" in e) {
    const { kind, message } = e as { kind?: unknown; message?: unknown };
    const result = KIND_TO_RESULT[kind as keyof typeof KIND_TO_RESULT];
    if (result) return { result, message: typeof message === "string" ? message : String(message) };
  }
  return { result: "memory-only", message: String(e) };
}
