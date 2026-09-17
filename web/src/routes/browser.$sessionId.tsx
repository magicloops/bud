import { createFileRoute } from "@tanstack/react-router";
import { BrowserViewer } from "@/features/browser/viewer";
import { useAuthSession } from "@/contexts/auth-session-context";
export const Route = createFileRoute("/browser/$sessionId")({
  component: BrowserRoute,
});
function BrowserRoute() {
  const { sessionId } = Route.useParams();
  const { currentUser } = useAuthSession();
  return currentUser ? (
    <BrowserViewer
      key={`${currentUser.user.id}:${sessionId}`}
      sessionId={sessionId}
    />
  ) : (
    <p>Sign in to open this browser.</p>
  );
}
