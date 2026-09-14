import { redirect } from "next/navigation";
import { getCurrentUserOrConfigError } from "@/lib/session";
import UploadClient from "./upload-client";

export default async function UploadPage() {
  const result = await getCurrentUserOrConfigError();

  if ("configError" in result) {
    return (
      <Notice title="Accounts are misconfigured">
        <code className="break-words">{result.configError}</code>
        <br />
        Fix the <strong>APP_USERS</strong> environment variable and reload.
      </Notice>
    );
  }

  const user = result.user;
  // The proxy already bounces anonymous requests; this covers a valid cookie
  // whose account was removed from APP_USERS in the meantime.
  if (!user) redirect("/login");

  if (user.projects.length === 0) {
    return (
      <Notice title="No project access">
        The account <strong>{user.username}</strong> has no projects assigned.
        Ask an admin to add one.
      </Notice>
    );
  }

  return (
    <UploadClient
      username={user.username}
      role={user.role}
      allowedProjects={user.projects}
    />
  );
}

function Notice({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 px-4">
      <div className="max-w-md text-center">
        <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-50">
          {title}
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-2">
          {children}
        </p>
      </div>
    </div>
  );
}
