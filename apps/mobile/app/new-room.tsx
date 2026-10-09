import { NewRoomSheet } from "../src/inbox/NewRoomSheet";
import { useSession } from "../src/session/SessionProvider";

export default function NewRoomRoute() {
  const session = useSession();
  return (
    <NewRoomSheet
      agents={session.agents}
      providers={session.providers}
      onCreateChat={(name, role, jobDescription, provider, modelId) =>
        session.createChat(name, role, jobDescription, provider, modelId)
      }
      onCreateGroup={(title, agentIds) => session.createGroup(title, agentIds)}
    />
  );
}
