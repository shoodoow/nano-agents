import { ApprovalsScreen } from "../src/approvals/ApprovalsScreen";
import { useSession } from "../src/session/SessionProvider";

export default function ApprovalsRoute() {
  const session = useSession();
  return (
    <ApprovalsScreen
      proposals={session.proposals}
      toolApprovals={session.toolApprovals}
      onApprove={(id) => void session.refreshProposals(id, true).catch(session.show)}
      onReject={(id) => void session.refreshProposals(id, false).catch(session.show)}
      onApproveTool={(id) => void session.decideToolRow(id, true).catch(session.show)}
      onDenyTool={(id) => void session.decideToolRow(id, false).catch(session.show)}
      onBack={() => {}}
    />
  );
}
