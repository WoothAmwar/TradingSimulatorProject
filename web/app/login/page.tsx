import { Suspense } from "react";
import { LoginButtons } from "@/components/login-buttons";

export default function LoginPage() {
  return (
    <div className="mx-auto mt-16 max-w-sm">
      <div className="panel p-6">
        <h1 className="text-lg font-semibold">Sign in</h1>
        <p className="mt-1 text-sm text-muted">
          Use your Google or GitHub account. There are no passwords.
        </p>
        <div className="mt-6">
          <Suspense>
            <LoginButtons />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
