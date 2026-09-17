import { api } from '../api/client';
import { GUILD_NAME } from '../config';

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  not_guild_member: "That Discord account isn't a member of the guild's server.",
  oauth_failed: 'Discord login failed. Please try again.',
  missing_code: 'Discord login was cancelled or did not return a code.',
  session_failed: 'Could not start a session. Please try again.'
};

export default function LoginScreen() {
  const params = new URLSearchParams(window.location.search);
  const authError = params.get('authError');

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-sm w-full text-center space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-amber-400">
            {`<${GUILD_NAME}>`}
          </h1>
          <p className="text-stone-400 mt-1">Guild Gear Bank</p>
        </div>

        {authError && (
          <div className="rounded-md border border-red-800 bg-red-950/60 px-4 py-3 text-sm text-red-300">
            {AUTH_ERROR_MESSAGES[authError] || 'Login failed. Please try again.'}
          </div>
        )}

        <a
          href={api.loginUrl()}
          className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-indigo-600 hover:bg-indigo-500 transition-colors px-4 py-2.5 font-medium text-white"
        >
          Log in with Discord
        </a>
        <p className="text-xs text-stone-500">
          You must be a member of the guild's Discord server to use this site.
        </p>
      </div>
    </div>
  );
}
