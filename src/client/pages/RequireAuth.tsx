import { useAuth } from "../auth";
import { Link } from "../components/Link";

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) {
    const next = encodeURIComponent(location.pathname + location.search);
    return (
      <div className="card narrow">
        <p>
          Please <Link href={`/login?next=${next}`}>sign in</Link> or <Link href={`/signup?next=${next}`}>create an account</Link>.
        </p>
      </div>
    );
  }
  return <>{children}</>;
}
