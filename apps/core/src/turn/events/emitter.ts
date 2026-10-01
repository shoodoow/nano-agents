/**
 * User-visible turn events: durable log then live SSE fanout.
 * Why: one choke point so replay and live share payloads. DB: `events` via appendEvent.
 */
import { appendEvent } from "../../rooms/events.js";
import type { Store } from "../../db/client.js";
import type { TurnEvent } from "../../rooms/send-message.js";
import type { StreamEvent } from "../../rooms/stream.js";

export class TurnEmitter {
  constructor(
    private readonly store: Store,
    private readonly scope: {
      accountId: string;
      conversationId: string;
      runId: string;
      onEvent?: (event: StreamEvent) => void;
    },
  ) {}

  async emit(event: TurnEvent): Promise<void> {
    try {
      const row = await appendEvent(this.store, {
        accountId: this.scope.accountId,
        conversationId: this.scope.conversationId,
        runId: this.scope.runId,
        event,
      });
      this.scope.onEvent?.({ ...event, cursor: row.id });
    } catch {
      this.scope.onEvent?.(event);
    }
  }

  emitDone(): void {
    this.scope.onEvent?.({ type: "done" });
  }
}
