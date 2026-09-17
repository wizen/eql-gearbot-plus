import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../api/client';
import { GUILD_NAME } from '../config';

export type Tab = 'gear' | 'work-orders' | 'import';

export default function Header({ tab, onTabChange }: { tab: Tab; onTabChange: (t: Tab) => void }) {
  const { user, logout } = useAuth();

  // Live version badge — read straight from the running backend (not baked
  // into this bundle at build time), so it always reflects what's actually
  // deployed right now even if the website and bot were updated at
  // different times. This is what settles "is Wispbyte running the latest
  // build" without needing console/SSH access: just look at the header.
  const [backendVersion, setBackendVersion] = useState<string | null>(null);
  useEffect(() => {
    api.get<{ status: string; version?: string }>('/api/health')
      .then(res => setBackendVersion(res.version || null))
      .catch(() => setBackendVersion(null));
  }, []);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'gear', label: 'Gear Bank' },
    { id: 'work-orders', label: 'Work Orders' },
    { id: 'import', label: 'Import Inventory' }
  ];

  return (
    <header className="border-b border-stone-800 bg-stone-950/80 backdrop-blur sticky top-0 z-10">
      <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold text-amber-400">{`<${GUILD_NAME}>`}</span>
          <span className="text-stone-500 hidden sm:inline">Gear Bank</span>
          {backendVersion && (
            <span
              className="text-[10px] text-stone-600 border border-stone-800 rounded px-1 py-0.5"
              title="Version reported live by the backend this page is talking to right now"
            >
              v{backendVersion}
            </span>
          )}
        </div>

        <nav className="flex gap-1">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => onTabChange(t.id)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                tab === t.id
                  ? 'bg-stone-800 text-white'
                  : 'text-stone-400 hover:text-stone-200 hover:bg-stone-900'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          {user && (
            <>
              {user.avatar && (
                <img src={user.avatar} alt="" className="w-7 h-7 rounded-full" />
              )}
              <span className="text-sm text-stone-300 hidden sm:inline">
                {user.displayName}
                {user.isOfficer && (
                  <span className="ml-1.5 text-xs text-amber-400 border border-amber-700 rounded px-1 py-0.5">
                    Officer
                  </span>
                )}
              </span>
              <button
                onClick={() => logout()}
                className="text-sm text-stone-400 hover:text-stone-200"
              >
                Log out
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
