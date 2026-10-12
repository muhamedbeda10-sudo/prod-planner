"use client";

import { useState, useTransition } from "react";
import { AlertCircle, Eye, EyeOff, Loader2, LogIn } from "lucide-react";
import { loginAction } from "./actions";

// The sign-in form: an email, a password that can be shown while it is typed,
// and the one reason a sign-in failed, right where it failed.

export function LoginForm() {
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setError(null);
    startTransition(async () => {
      const res = await loginAction(fd);
      if (res && !res.ok) setError(res.error ?? "Sign-in failed.");
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate={false}>
      <label className="block">
        <span className="field-label">Email</span>
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
          className="w-full px-3 py-2.5 text-[15px] font-semibold ltr"
          placeholder="you@gmail.com"
        />
      </label>
      <label className="block">
        <span className="field-label">Password</span>
        <span className="relative block">
          <input
            name="password"
            type={show ? "text" : "password"}
            autoComplete="current-password"
            required
            className="w-full px-3 py-2.5 pe-11 text-[15px] font-semibold ltr"
            placeholder="••••••••"
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            className="icon-btn icon-btn-md absolute end-1.5 top-1/2 -translate-y-1/2"
            aria-label={show ? "Hide the password" : "Show the password"}
            title={show ? "Hide the password" : "Show the password"}
            tabIndex={-1}
          >
            {show ? <EyeOff size={17} /> : <Eye size={17} />}
          </button>
        </span>
      </label>
      {error && (
        <p className="alert alert-bad" role="alert">
          <AlertCircle size={16} className="shrink-0 mt-px" aria-hidden />
          <span>{error}</span>
        </p>
      )}
      <button type="submit" disabled={pending} className="btn btn-primary w-full py-2.5 text-[15px]">
        {pending ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <LogIn size={16} aria-hidden />}
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
