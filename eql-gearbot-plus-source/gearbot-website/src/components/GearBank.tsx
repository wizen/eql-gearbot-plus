import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../context/AuthContext';
import type { GearItem } from '../types';

export default function GearBank() {
  const { user } = useAuth();
  const [items, setItems] = useState<GearItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const [itemName, setItemName] = useState('');
  const [isStock, setIsStock] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // eqlwiki autocomplete for the item name field — same pattern as
  // WorkOrders.tsx (both call /api/wiki/autocomplete, which wraps
  // wikiScraper.searchWikiAutocomplete, the same function /g-add's Discord
  // autocomplete uses). Case normalization and the hard "does this item
  // actually exist" check still happen server-side on submit regardless
  // (see POST /api/gear/add and /api/gear/stock) — this is just the
  // as-you-type assist, not the source of truth.
  const [itemSuggestions, setItemSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const query = itemName.trim();
    if (query.length < 2) {
      setItemSuggestions([]);
      setSuggestLoading(false);
      return;
    }

    setSuggestLoading(true);
    const thisRequestId = ++requestIdRef.current;
    debounceRef.current = setTimeout(async () => {
      try {
        const { suggestions } = await api.get<{ suggestions: string[] }>(`/api/wiki/autocomplete?q=${encodeURIComponent(query)}`);
        if (thisRequestId === requestIdRef.current) {
          setItemSuggestions(suggestions);
        }
      } catch {
        if (thisRequestId === requestIdRef.current) setItemSuggestions([]);
      } finally {
        if (thisRequestId === requestIdRef.current) setSuggestLoading(false);
      }
    }, 250);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [itemName]);

  function selectSuggestion(name: string) {
    setItemName(name);
    setItemSuggestions([]);
    setShowSuggestions(false);
  }

  async function load() {
    setLoading(true);
    try {
      const { items } = await api.get<{ items: GearItem[] }>('/api/gear');
      setItems(items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load gear bank');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    if (!itemName.trim()) return;
    setSubmitting(true);
    setFormError(null);
    try {
      if (isStock) {
        await api.post('/api/gear/stock', { itemName: itemName.trim(), quantity });
      } else {
        await api.post('/api/gear/add', { itemName: itemName.trim() });
      }
      setItemName('');
      setQuantity(1);
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Failed to add item');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAction(id: number, action: 'claim' | 'withdraw' | 'remove') {
    setBusyId(id);
    try {
      if (action === 'remove') {
        await api.del(`/api/gear/${id}`);
      } else {
        await api.post(`/api/gear/${id}/${action}`);
      }
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to ${action} item`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      <form onSubmit={handleAdd} className="rounded-lg border border-stone-800 bg-stone-900/50 p-4 space-y-3">
        <h2 className="font-semibold text-stone-200">Donate an item</h2>
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[200px] relative">
            <label className="block text-xs text-stone-400 mb-1">Item name</label>
            <input
              value={itemName}
              onChange={e => { setItemName(e.target.value); setShowSuggestions(true); }}
              onFocus={() => setShowSuggestions(true)}
              // Delay so a click on a suggestion registers before the list unmounts
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              placeholder={isStock ? 'Water Flask' : 'Rubicite Breastplate +2'}
              autoComplete="off"
              title="Matched against eqlwiki.com — whatever you pick or type is normalized to the wiki's exact name when submitted"
              className="w-full rounded-md bg-stone-800 border border-stone-700 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
            {showSuggestions && (suggestLoading || itemSuggestions.length > 0) && (
              <ul className="absolute z-10 mt-1 w-full max-h-56 overflow-y-auto rounded-md border border-stone-700 bg-stone-800 shadow-lg">
                {suggestLoading && itemSuggestions.length === 0 && (
                  <li className="px-3 py-2 text-xs text-stone-500">Searching eqlwiki.com…</li>
                )}
                {itemSuggestions.map(name => (
                  <li key={name}>
                    <button
                      type="button"
                      // onMouseDown (not onClick) fires before the input's onBlur
                      onMouseDown={() => selectSuggestion(name)}
                      className="w-full text-left px-3 py-2 text-sm text-stone-200 hover:bg-stone-700"
                    >
                      {name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm text-stone-400 pb-2">
            <input type="checkbox" checked={isStock} onChange={e => setIsStock(e.target.checked)} />
            Stackable
          </label>
          {isStock && (
            <div className="w-24">
              <label className="block text-xs text-stone-400 mb-1">Qty</label>
              <input
                type="number"
                min={1}
                value={quantity}
                onChange={e => setQuantity(parseInt(e.target.value, 10) || 1)}
                className="w-full rounded-md bg-stone-800 border border-stone-700 px-3 py-2 text-sm"
              />
            </div>
          )}
          <button
            type="submit"
            disabled={submitting || !itemName.trim()}
            className="rounded-md bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-medium text-stone-950"
          >
            {submitting ? 'Adding…' : 'Add to gear bank'}
          </button>
        </div>
        {formError && <p className="text-sm text-red-400">{formError}</p>}
      </form>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {loading ? (
        <p className="text-stone-500 text-sm">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-stone-500 text-sm">Nothing in the gear bank yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-stone-800">
          <table className="w-full text-sm">
            <thead className="bg-stone-900 text-stone-400 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">Item</th>
                <th className="px-3 py-2 font-medium">Lvl</th>
                <th className="px-3 py-2 font-medium">Held by</th>
                <th className="px-3 py-2 font-medium">Requested by</th>
                <th className="px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-800">
              {items.map(item => {
                const isOwner = user?.id === item.added_by_user_id;
                const isClaimant = user?.id === item.requested_by_user_id;
                const canRemove = isOwner || user?.isOfficer;
                const canWithdraw = isClaimant || user?.isOfficer;
                const canClaim = !item.requested_by_user_id && !isOwner;
                const busy = busyId === item.id;

                return (
                  <tr key={item.id} className="hover:bg-stone-900/40">
                    <td className="px-3 py-2 text-stone-500">{item.id}</td>
                    <td className="px-3 py-2">
                      <a href={item.wiki_url} target="_blank" rel="noreferrer" className="text-amber-300 hover:underline">
                        {item.base_item_name}
                      </a>
                    </td>
                    <td className="px-3 py-2 text-stone-400">{item.upgrade_level}</td>
                    <td className="px-3 py-2 text-stone-300">{item.added_by_username}</td>
                    <td className="px-3 py-2 text-stone-300">
                      {item.requested_by_username || <span className="text-stone-600">—</span>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-2">
                        {canClaim && (
                          <button
                            disabled={busy}
                            onClick={() => handleAction(item.id, 'claim')}
                            className="text-xs rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 px-2 py-1"
                          >
                            Claim
                          </button>
                        )}
                        {canWithdraw && item.requested_by_user_id && (
                          <button
                            disabled={busy}
                            onClick={() => handleAction(item.id, 'withdraw')}
                            className="text-xs rounded bg-stone-700 hover:bg-stone-600 disabled:opacity-50 px-2 py-1"
                          >
                            Withdraw
                          </button>
                        )}
                        {canRemove && (
                          <button
                            disabled={busy}
                            onClick={() => handleAction(item.id, 'remove')}
                            className="text-xs rounded bg-red-800 hover:bg-red-700 disabled:opacity-50 px-2 py-1"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
