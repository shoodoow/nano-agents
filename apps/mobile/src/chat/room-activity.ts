export type RoomActivityPhase = "thinking" | "working" | "teammates";

/**
 * Maps turn phase to footer copy for the open chat.
 * Input: phase, primary agent name, group flag.
 * Output: one short status line.
 */
export function roomActivityLabel(phase: RoomActivityPhase, agentName: string, isGroup: boolean): string {
  switch (phase) {
    case "thinking":
      return isGroup ? `${agentName} is thinking…` : `${agentName} is typing…`;
    case "working":
      return `${agentName} is working…`;
    case "teammates":
      return "Waiting for teammates…";
    default:
      return `${agentName} is typing…`;
  }
}
