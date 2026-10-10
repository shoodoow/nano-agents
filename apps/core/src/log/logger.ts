import pino from "pino";
import { config } from "../config.js";

/** The core's one log. Cookies and tokens in request headers are never written. */
export const logger = pino({
  level: config.logLevel(),
  redact: ["req.headers.cookie", "req.headers.authorization", "res.headers['set-cookie']"],
});

/**
 * A `.catch()` handler for work whose failure must not stop the caller.
 * Why: these failures used to vanish in an empty handler, so a broken
 * heartbeat or a transcript that never saved left no trace anywhere.
 * Input: what was being done, in a few words.
 * Output: a handler that writes the failure to the log and yields undefined.
 * A busy room is an expected outcome, not a fault, and is logged quietly.
 */
export function noted(what: string): (error: unknown) => undefined {
  return (error) => {
    const expected = error instanceof Error && error.name === "RoomBusyError";
    logger[expected ? "debug" : "warn"]({ err: error }, `${what} failed`);
    return undefined;
  };
}
