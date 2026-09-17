import { useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { GroupedImportItem } from '../types';

export default function ImportInventory() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<GroupedImportItem[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ imported: string[]; failed: string[] } | null>(null);

  async function handleFile(file: File) {
    if (!file.name.toLowerCase().endsWith('-inventory.txt')) {
      setError('Please choose the <CharacterName>-Inventory.txt file produced by /outputfile inventory in game.');
      return;
    }
    setParsing(true);
    setError(null);
    setResult(null);
    try {
      const fileContent = await file.text();
      const { items } = await api.post<{ items: GroupedImportItem[] }>('/api/import/parse', { fileContent });
      setItems(items);
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to parse inventory file');
    } finally {
      setParsing(false);
    }
  }

  function toggle(idx: number) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  async function handleConfirm() {
    const selectedItems = items.filter((_, idx) => selected.has(idx));
    if (selectedItems.length === 0) return;
    setImporting(true);
    setError(null);
    try {
      const res = await api.post<{ details: { imported: string[]; failed: string[] } }>(
        '/api/import/confirm',
        { selectedItems }
      );
      setResult(res.details);
      setItems([]);
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      <div className="rounded-lg border border-stone-800 bg-stone-900/50 p-4 space-y-3">
        <h2 className="font-semibold text-stone-200">Import from an EverQuest inventory file</h2>
        <p className="text-sm text-stone-400">
          In game, run <code className="bg-stone-800 px-1 rounded">/outputfile inventory</code> (no filename needed —
          EQ names the file <code className="bg-stone-800 px-1 rounded">&lt;CharacterName&gt;-Inventory.txt</code> for
          you), then upload that file here to pick which items to donate to the guild gear bank.
          Equipped/worn gear is skipped — only bags and bank contents are considered.
        </p>
        <input
          ref={fileInputRef}
          type="file"
          // The accept attribute can only filter by extension, not filename pattern
          // (browsers have no wildcard-filename support here) — .txt narrows the
          // OS file picker as far as it can, and handleFile() above does the real
          // *-Inventory.txt check once a file is actually chosen.
          accept=".txt"
          onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}
          className="text-sm text-stone-300 file:mr-3 file:rounded-md file:border-0 file:bg-amber-600 file:px-3 file:py-2 file:text-sm file:font-medium file:text-stone-950 hover:file:bg-amber-500"
        />
        {parsing && <p className="text-sm text-stone-500">Parsing…</p>}
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>

      {result && (
        <div className="rounded-lg border border-emerald-800 bg-emerald-950/40 p-4 text-sm space-y-1">
          <p className="text-emerald-300 font-medium">Imported {result.imported.length} item(s).</p>
          {result.failed.length > 0 && (
            <p className="text-amber-300">{result.failed.length} item(s) could not be verified on eqlwiki and were skipped.</p>
          )}
        </div>
      )}

      {items.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-stone-400">{selected.size} of {items.length} selected</p>
            <button
              onClick={handleConfirm}
              disabled={importing || selected.size === 0}
              className="rounded-md bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-medium text-stone-950"
            >
              {importing ? 'Importing…' : `Donate ${selected.size} item(s)`}
            </button>
          </div>

          <div className="divide-y divide-stone-800 rounded-lg border border-stone-800">
            {items.map((item, idx) => (
              <label key={idx} className="flex items-center gap-3 px-3 py-2 hover:bg-stone-900/40 cursor-pointer">
                <input type="checkbox" checked={selected.has(idx)} onChange={() => toggle(idx)} />
                <div className="flex-1">
                  <p className="text-sm text-stone-200">
                    {item.cleanItemName}
                    {item.upgradeLevel !== '+0' && <span className="text-stone-500"> {item.upgradeLevel}</span>}
                    <span className="text-stone-500"> ×{item.totalCount}</span>
                  </p>
                  {item.exaltsSummary && <p className="text-xs text-amber-400">{item.exaltsSummary}</p>}
                </div>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
