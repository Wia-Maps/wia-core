import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { useAdminAuth } from '../../context/AdminAuthContext';
import { useToast } from '../../context/ToastContext';
import { AdminStatusBadge } from './AdminUi';

const EyeOpenIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
    <path
      d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="12" cy="12" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.8" />
  </svg>
);

const EyeOffIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
    <path
      d="M3 3l18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
    <path
      d="M10.7 6.2A10.9 10.9 0 0 1 12 6c6.5 0 10 6 10 6a16.8 16.8 0 0 1-3.3 3.9M6.2 8.1C3.9 10.1 2 12 2 12s3.5 6 10 6c1.5 0 2.8-.3 4-.8"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const AdminLoginPage: React.FC = () => {
  const { loading, login } = useAdminAuth();
  const { showError, showSuccess } = useToast();
  const [formState, setFormState] = useState({
    email: '',
    password: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const { name, value } = event.target;
    setFormState((current) => ({
      ...current,
      [name]: value,
    }));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);

    try {
      await login(formState);
      showSuccess('Welcome back. Admin access is now active.', {
        title: 'Signed in',
        dedupeKey: 'admin-login-success',
      });
    } catch (loginError) {
      showError(loginError instanceof Error ? loginError.message : 'Unable to sign in', {
        title: 'Sign-in failed',
        dedupeKey: 'admin-login-error',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/30 p-4 backdrop-blur-sm">
      <section className="w-full max-w-xl rounded-[32px] border border-slate-200 bg-white p-6 shadow-[0_24px_80px_rgba(15,23,42,0.18)] md:p-8">
        <div className="flex flex-wrap items-center gap-2">
          <AdminStatusBadge tone="warning">Workspace locked</AdminStatusBadge>
          <AdminStatusBadge>Admin access</AdminStatusBadge>
        </div>
        <h2 className="mt-4 font-['Outfit'] text-3xl font-semibold text-slate-950">Sign in to manage operations</h2>
        <p className="mt-3 max-w-lg text-sm leading-6 text-slate-600">Editing and publishing require admin sign-in.</p>

        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-700">Email</span>
            <input
              type="email"
              name="email"
              value={formState.email}
              onChange={handleChange}
              placeholder="admin@campus.edu"
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-slate-900 shadow-sm outline-none transition focus:border-cyan-500 focus:ring-4 focus:ring-cyan-100"
              required
            />
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-700">Password</span>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                name="password"
                value={formState.password}
                onChange={handleChange}
                placeholder="Enter password"
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 pr-14 text-slate-900 shadow-sm outline-none transition focus:border-cyan-500 focus:ring-4 focus:ring-cyan-100"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                title={showPassword ? 'Hide password' : 'Show password'}
                className="absolute right-2 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-700 transition hover:border-slate-400 hover:text-slate-900"
              >
                {showPassword ? <EyeOffIcon /> : <EyeOpenIcon />}
              </button>
            </div>
          </label>

          <button
            type="submit"
            disabled={submitting || loading}
            className="inline-flex w-full items-center justify-center rounded-full bg-gradient-to-r from-cyan-600 to-sky-600 px-5 py-3 text-sm font-semibold text-white shadow-[0_18px_34px_rgba(14,116,144,0.3)] transition hover:from-cyan-500 hover:to-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting || loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </section>
    </div>
  );
};
