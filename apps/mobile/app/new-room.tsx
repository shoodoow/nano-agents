import { NewRoomSheet } from "../src/inbox/NewRoomSheet";
import { useSession } from "../src/session/SessionProvider";

export default function NewRoomRoute() {
  const session = useSession();
  return (
    <NewRoomSheet
      agents={session.agents}
      providers={session.providers}
      onCreateChat={(name, role, jobDescription, provider, modelId) =>
        void session.createChat(name, role, jobDescription, provider, modelId).catch(session.show)
      }
      onCreateGroup={(title, agentIds) => void session.createGroup(title, agentIds).catch(session.show)}
    />
  );
}
