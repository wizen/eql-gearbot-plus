import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../context/AuthContext';
import type { WorkOrder, WorkOrderStatus } from '../types';

const STATUS_LABEL: Record<WorkOrderStatus, string> = {
  unclaimed: '🟢 Unclaimed',
  claimed: '🟡 Claimed',
  complete: '✅ Complete',
  delivered: '📬 Delivered',
  cancelled: '🚫 Cancelled'
};

type FilterValue = WorkOrderStatus | 'all';

export default function WorkOrders() {
  const { user } = useAuth();
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [filter, setFilter] = useState<FilterValue>('unclaimed');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const [itemName, setItemName] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // eqlwiki autocomplete for the item name field — mirrors /g-addwork's
  // Discord autocomplete (both call the same wikiScraper.searchWikiAutocomplete
  // via /api/wiki/autocomplete). Case normalization and the hard "does this
  // item actually exist" check happen server-side on submit regardless (see
  // POST /api/work-orders in api/routes/workOrders.js) — this is just the
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
        // Ignore stale responses from a query that's since been superseded
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

  async function load(status: FilterValue) {
    setLoading(true);
    try {
      const { orders } = await api.get<{ orders: WorkOrder[] }>(`/api/work-orders?status=${status}`);
      setOrders(orders);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load work orders');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!itemName.trim()) return;
    setSubmitting(true);
    setFormError(null);
    try {
      // Skill + trivial are never sent from here — the API always looks
      // them up itself from the item's recorded player-crafted recipe on
      // eqlwiki.com (same as /g-addwork in Discord) — see POST /work-orders
      // in api/routes/workOrders.js.
      await api.post('/api/work-orders', {
        itemName: itemName.trim(),
        quantity,
        notes: notes.trim() || null
      });
      setItemName('');
      setQuantity(1);
      setNotes('');
      await load(filter);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Failed to create work order');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAction(id: number, action: 'claim' | 'complete' | 'deliver' | 'cancel') {
    setBusyId(id);
    try {
      await api.post(`/api/work-orders/${id}/${action}`);
      await load(filter);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to ${action} order`);
    } finally {
      setBusyId(null);
    }
  }

  // Officer-only, any status, immediate and permanent — distinct from
  // cancel, which only works pre-completion and still waits out its 24h
  // grace window (see api/routes/workOrders.js's DELETE route + db.js).
  async function handleDelete(id: number) {
    setBusyId(id);
    try {
      await api.del(`/api/work-orders/${id}`);
      await load(filter);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete order');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      <form onSubmit={handleCreate} className="rounded-lg border border-stone-800 bg-stone-900/50 p-4 space-y-3">
        <h2 className="font-semibold text-stone-200">Request a work order</h2>
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[200px] relative">
            <label className="block text-xs text-stone-400 mb-1">Item needed</label>
            <input
              value={itemName}
              onChange={e => { setItemName(e.target.value); setShowSuggestions(true); }}
              onFocus={() => setShowSuggestions(true)}
              // Delay so a click on a suggestion registers before the list unmounts
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              placeholder="Fine Steel Two Handed Sword"
              autoComplete="off"
              title="Matched against eqlwiki.com — whatever you pick or type is normalized to the wiki's exact name when the order is posted"
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
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs text-stone-400 mb-1">Notes (optional)</label>
            <input
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Will provide materials + 100pp tip"
              className="w-full rounded-md bg-stone-800 border border-stone-700 px-3 py-2 text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={submitting || !itemName.trim()}
            className="rounded-md bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-medium text-stone-950"
          >
            {submitting ? 'Posting…' : 'Post work order'}
          </button>
        </div>
        {formError && <p className="text-sm text-red-400">{formError}</p>}
      </form>

      <div className="flex gap-1">
        {(['unclaimed', 'claimed', 'complete', 'delivered', 'all'] as FilterValue[]).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              filter === f ? 'bg-stone-800 text-white' : 'text-stone-400 hover:bg-stone-900'
            }`}
          >
            {f === 'all' ? 'All' : STATUS_LABEL[f]}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {loading ? (
        <p className="text-stone-500 text-sm">Loading…</p>
      ) : orders.length === 0 ? (
        <p className="text-stone-500 text-sm">No work orders here.</p>
      ) : (
        <div className="space-y-2">
          {orders.map(order => {
            const isRequester = user?.id === order.requester_discord_id;
            const isCrafter = user?.id === order.claimed_by_discord_id;
            const busy = busyId === order.id;

            return (
              <div key={order.id} className="rounded-lg border border-stone-800 bg-stone-900/40 p-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-medium text-stone-200">
                    #{order.id} {order.item_name} <span className="text-stone-500">×{order.quantity}</span>
                  </p>
                  <p className="text-xs text-stone-400 mt-0.5">
                    {STATUS_LABEL[order.status]} · {order.skill_required}
                    {order.skill_level_required ? ` (Trivial: ${order.skill_level_required})` : ''} · Requested by {order.requester_character}
                    {order.claimed_by_discord_name && <> · Crafter: {order.claimed_by_discord_name}</>}
                  </p>
                  {order.notes && <p className="text-xs text-stone-500 mt-0.5 italic">{order.notes}</p>}
                </div>
                <div className="flex gap-2">
                  {order.status === 'unclaimed' && !isRequester && (
                    <button
                      disabled={busy}
                      onClick={() => handleAction(order.id, 'claim')}
                      className="text-xs rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 px-2 py-1"
                    >
                      Claim
                    </button>
                  )}
                  {order.status === 'claimed' && (isCrafter || isRequester || user?.isOfficer) && (
                    <button
                      disabled={busy}
                      onClick={() => handleAction(order.id, 'complete')}
                      className="text-xs rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 px-2 py-1"
                    >
                      Mark complete
                    </button>
                  )}
                  {order.status === 'complete' && (isCrafter || isRequester || user?.isOfficer) && (
                    <button
                      disabled={busy}
                      onClick={() => handleAction(order.id, 'deliver')}
                      className="text-xs rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-50 px-2 py-1"
                    >
                      Mark delivered
                    </button>
                  )}
                  {(order.status === 'unclaimed' || order.status === 'claimed') && (isRequester || user?.isOfficer) && (
                    <button
                      disabled={busy}
                      onClick={() => handleAction(order.id, 'cancel')}
                      className="text-xs rounded bg-red-800 hover:bg-red-700 disabled:opacity-50 px-2 py-1"
                    >
                      Cancel
                    </button>
                  )}
                  {user?.isOfficer && (
                    <button
                      disabled={busy}
                      onClick={() => handleDelete(order.id)}
                      title="Officer: permanently remove this order right now, regardless of status"
                      className="text-xs rounded bg-red-950 hover:bg-red-900 border border-red-800 disabled:opacity-50 px-2 py-1"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
