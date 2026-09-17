import { useState } from 'react';
import { useAuth } from './context/AuthContext';
import LoginScreen from './components/LoginScreen';
import Header, { type Tab } from './components/Header';
import GearBank from './components/GearBank';
import WorkOrders from './components/WorkOrders';
import ImportInventory from './components/ImportInventory';

export default function App() {
  const { user, loading, error } = useAuth();
  const [tab, setTab] = useState<Tab>('gear');

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-stone-500 text-sm">
        Loading…
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <p className="text-red-400 text-sm text-center max-w-sm">
          Couldn't reach the gear bot API. Is it running? ({error})
        </p>
      </div>
    );
  }

  if (!user) {
    return <LoginScreen />;
  }

  return (
    <div className="min-h-screen">
      <Header tab={tab} onTabChange={setTab} />
      {tab === 'gear' && <GearBank />}
      {tab === 'work-orders' && <WorkOrders />}
      {tab === 'import' && <ImportInventory />}
    </div>
  );
}
