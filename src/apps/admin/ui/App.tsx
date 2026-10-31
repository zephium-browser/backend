import { useEffect } from "preact/hooks";
import { AuthScreen } from "./auth/AuthScreen";
import { loadSession, signOut, useSession } from "./auth/session";
import { Shell } from "./components/Shell";
import { Skeleton } from "./components/States";
import { type Route, useRoute } from "./router";
import { ActivityView } from "./views/Activity";
import { AuditView } from "./views/Audit";
import { JobsView } from "./views/Jobs";
import { OverviewView } from "./views/Overview";
import { RevenueView } from "./views/Revenue";
import { UserDetailView } from "./views/UserDetail";
import { UsersView } from "./views/Users";
import { WaitlistView } from "./views/Waitlist";

function View({ route }: { route: Route }) {
  switch (route.name) {
    case "overview":
      return <OverviewView days={route.days} />;
    case "revenue":
      return <RevenueView />;
    case "activity":
      return <ActivityView days={route.days} />;
    case "users":
      return <UsersView q={route.q} filter={route.filter} />;
    case "user":
      return <UserDetailView id={route.id} />;
    case "jobs":
      return <JobsView />;
    case "waitlist":
      return <WaitlistView />;
    case "audit":
      return <AuditView />;
    default:
      return (
        <div class="empty">
          <h1 class="page-title">Page not found</h1>
          <p class="empty-body">
            <a href="#/overview">Go to the overview</a>
          </p>
        </div>
      );
  }
}

function Reload({ message }: { message: string }) {
  return (
    <main class="auth" id="main">
      <section class="auth-card" aria-labelledby="expired-title">
        <h1 id="expired-title" class="auth-title">
          Session expired
        </h1>
        <p role="alert">{message}</p>
        <button type="button" class="btn btn-primary" onClick={() => location.reload()}>
          Reload page
        </button>
      </section>
    </main>
  );
}

export function App() {
  const session = useSession();
  const route = useRoute();
  useEffect(() => {
    void loadSession();
  }, []);

  if (session.accessExpired && session.phase !== "ready")
    return <Reload message="Your Cloudflare Access session expired — reload the page." />;
  if (session.phase === "loading")
    return (
      <main class="auth" id="main">
        <div class="auth-card">
          <Skeleton lines={3} />
        </div>
      </main>
    );
  if (session.phase !== "ready" || !session.operator)
    return (
      <AuthScreen
        phase={session.phase === "ready" ? "signed_out" : session.phase}
        notice={session.notice}
        setup={session.setup}
        email={session.operator?.email ?? null}
      />
    );
  return (
    <Shell
      operator={session.operator}
      route={route}
      accessExpired={session.accessExpired}
      onSignOut={() => void signOut()}
    >
      <View route={route} />
    </Shell>
  );
}
