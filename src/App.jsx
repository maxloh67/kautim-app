import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import Tesseract from 'tesseract.js';
import {
  Users, Receipt, Plus, Trash2, Wallet, MessageSquare, Copy, Check,
  ChevronDown, ChevronUp, X, Pencil, ArrowRight, Loader2, RefreshCw,
  UserPlus, AtSign, CircleDollarSign, ClipboardCheck, Camera, QrCode, Send
} from 'lucide-react';

/* ----------------------------- helpers ----------------------------- */

const DATA_KEY = 'kautim-data';
const IDENTITY_KEY = 'kautim-identity';
const DEFAULT_TAX = 6;
const DEFAULT_SERVICE = 10;

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const fmt = (n) => `RM ${round2(n).toFixed(2)}`;
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const todayISO = () => new Date().toISOString().slice(0, 10);
const niceDate = (iso) => {
  try {
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch (e) { return iso; }
};

function emptyData() { return { roster: [], bills: [] }; }

/* NOTE: For real-time sync, replace window.storage with Firebase Firestore:
  import { doc, getDoc, setDoc, onSnapshot } from "firebase/firestore";
  import { db } from "./firebase-config";
*/
async function loadData() {
  if (typeof window === 'undefined' || !window.storage) return emptyData();
  try {
    const res = await window.storage.get(DATA_KEY, true);
    if (res && res.value) {
      const parsed = JSON.parse(res.value);
      return { roster: parsed.roster || [], bills: parsed.bills || [] };
    }
  } catch (e) { }
  return emptyData();
}
async function persistData(data) {
  if (typeof window === 'undefined' || !window.storage) return false;
  try {
    await window.storage.set(DATA_KEY, JSON.stringify(data), true);
    return true;
  } catch (e) { console.error('Kautim: save failed', e); return false; }
}
async function loadIdentity() {
  if (typeof window === 'undefined' || !window.storage) return null;
  try {
    const res = await window.storage.get(IDENTITY_KEY, false);
    if (res && res.value) return JSON.parse(res.value).personId || null;
  } catch (e) { }
  return null;
}
async function persistIdentity(personId) {
  if (typeof window === 'undefined' || !window.storage) return;
  try { await window.storage.set(IDENTITY_KEY, JSON.stringify({ personId }), false); }
  catch (e) { console.error('Kautim: identity save failed', e); }
}

function personName(roster, id) {
  const p = roster.find(r => r.id === id);
  return p ? p.name : 'Unknown';
}

function computeBill(bill) {
  const perPerson = {};
  const ensure = (pid) => { if (!perPerson[pid]) perPerson[pid] = { subtotal: 0 }; return perPerson[pid]; };
  let itemsTotal = 0;
  let allocatedTotal = 0;

  (bill.items || []).forEach(item => {
    const lineTotal = round2(item.unitPrice * (item.quantity || 1));
    itemsTotal = round2(itemsTotal + lineTotal);
    (item.assignments || []).forEach(a => {
      const p = ensure(a.personId);
      p.subtotal = round2(p.subtotal + (a.amount || 0));
      allocatedTotal = round2(allocatedTotal + (a.amount || 0));
    });
  });

  const taxRate = (bill.taxRate ?? DEFAULT_TAX) / 100;
  const serviceRate = (bill.serviceRate ?? DEFAULT_SERVICE) / 100;

  let grandTotal = 0;
  Object.keys(perPerson).forEach(pid => {
    const p = perPerson[pid];
    p.tax = round2(p.subtotal * taxRate);
    p.service = round2(p.subtotal * serviceRate);
    p.totalOwed = round2(p.subtotal + p.tax + p.service);
    grandTotal = round2(grandTotal + p.totalOwed);
  });

  let roundingAdj = 0;
  if (bill.receiptTotal != null && bill.receiptTotal !== '' && Number(bill.receiptTotal) > 0) {
    roundingAdj = round2(Number(bill.receiptTotal) - grandTotal);
  }

  Object.keys(perPerson).forEach(pid => {
    const p = perPerson[pid];
    const paid = round2((bill.payments || [])
      .filter(pm => pm.personId === pid)
      .reduce((s, pm) => s + (pm.amount || 0), 0));
    p.paid = paid;
    p.remaining = round2(p.totalOwed - paid);
  });

  return {
    perPerson,
    itemsTotal,
    allocatedTotal,
    grandTotal,
    unallocated: round2(itemsTotal - allocatedTotal),
    roundingAdj,
  };
}

function computeLedger(data) {
  const pairs = {};
  data.bills.forEach(bill => {
    if (!bill.payerId) return;
    const { perPerson } = computeBill(bill);
    Object.entries(perPerson).forEach(([pid, p]) => {
      if (pid === bill.payerId) return;
      if (round2(p.remaining) === 0) return;
      const key = `${pid}__${bill.payerId}`;
      if (!pairs[key]) pairs[key] = { debtorId: pid, payerId: bill.payerId, amount: 0, billIds: [] };
      pairs[key].amount = round2(pairs[key].amount + p.remaining);
      pairs[key].billIds.push(bill.id);
    });
  });
  return Object.values(pairs).filter(p => Math.abs(p.amount) >= 0.01);
}

function isBillSettled(bill) {
  const { perPerson } = computeBill(bill);
  return Object.values(perPerson).every(p => round2(p.remaining) <= 0.004);
}

/* ----------------------------- small bits ----------------------------- */

function StampBadge({ kind, children }) {
  const styles = kind === 'settled'
    ? { color: 'var(--settled)', borderColor: 'var(--settled)', background: 'var(--settled-bg)' }
    : { color: 'var(--owe)', borderColor: 'var(--owe)', background: 'var(--owe-bg)' };
  return (
    <span className="stamp-badge" style={{ ...styles, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 9px', borderRadius: 999, border: '1.5px dashed', fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

function EmptyState({ icon: Icon, title, body, action }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 20px', border: '1.5px dashed var(--line)', borderRadius: 14, background: 'var(--paper-dim)' }}>
      <Icon size={28} strokeWidth={1.5} style={{ color: 'var(--ink-soft)', marginBottom: 10 }} />
      <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 16, color: 'var(--ink)' }}>{title}</div>
      <div style={{ color: 'var(--ink-soft)', fontSize: 13.5, marginTop: 4, maxWidth: 340, marginInline: 'auto', lineHeight: 1.5 }}>{body}</div>
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}

function Field({ label, children, hint }) {
  return (
    <label style={{ display: 'block' }}>
      <span style={{ display: 'block', fontSize: 11.5, fontWeight: 600, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5 }}>{label}</span>
      {children}
      {hint && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--ink-soft)', marginTop: 4 }}>{hint}</span>}
    </label>
  );
}

const inputStyle = { width: '100%', boxSizing: 'border-box', padding: '9px 11px', borderRadius: 9, border: '1.5px solid var(--line)', background: '#fff', color: 'var(--ink)', fontSize: 14, fontFamily: "'Inter', sans-serif", outline: 'none' };
const monoInputStyle = { ...inputStyle, fontFamily: "'IBM Plex Mono', monospace", textAlign: 'right' };

function TextInput(props) { return <input {...props} style={{ ...inputStyle, ...(props.style || {}) }} className={`ki-input ${props.className || ''}`} />; }
function NumberInput(props) { return <input type="number" {...props} style={{ ...monoInputStyle, ...(props.style || {}) }} className={`ki-input ${props.className || ''}`} />; }

function PrimaryButton({ children, icon: Icon, loading, ...rest }) {
  return (
    <button {...rest} className="ki-btn-primary" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '10px 16px', borderRadius: 10, border: 'none', background: 'var(--ink)', color: 'var(--paper)', fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 14, cursor: rest.disabled || loading ? 'not-allowed' : 'pointer', opacity: rest.disabled || loading ? 0.4 : 1, ...(rest.style || {}) }}>
      {loading ? <Loader2 size={16} style={{ animation: 'ki-spin 0.8s linear infinite' }} /> : Icon && <Icon size={16} />}
      {children}
    </button>
  );
}

function GhostButton({ children, icon: Icon, ...rest }) {
  return (
    <button {...rest} className="ki-btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 13px', borderRadius: 9, border: '1.5px solid var(--line)', background: 'transparent', color: 'var(--ink)', fontFamily: "'Inter', sans-serif", fontWeight: 600, fontSize: 13.5, cursor: rest.disabled ? 'not-allowed' : 'pointer', opacity: rest.disabled ? 0.4 : 1, ...(rest.style || {}) }}>
      {Icon && <Icon size={14} />}
      {children}
    </button>
  );
}

function IconButton({ icon: Icon, label, danger, ...rest }) {
  return (
    <button {...rest} title={label} aria-label={label} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 8, border: '1.5px solid var(--line)', background: '#fff', color: danger ? 'var(--owe)' : 'var(--ink-soft)', cursor: 'pointer', ...(rest.style || {}) }}>
      <Icon size={15} />
    </button>
  );
}

/* ----------------------------- header / nav ----------------------------- */

const TABS = [
  { id: 'ledger', label: 'Ledger', code: 'LG-01', icon: Wallet },
  { id: 'newbill', label: 'New Bill', code: 'BL-02', icon: Receipt },
  { id: 'people', label: 'People', code: 'PP-03', icon: Users },
  { id: 'message', label: 'Message', code: 'MS-04', icon: MessageSquare },
];

function Header({ view, setView, onRefresh, refreshing }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 18 }}>
        <div>
          <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 27, color: 'var(--ink)', letterSpacing: '-0.01em', lineHeight: 1 }}>
            Kautim<span style={{ color: 'var(--stamp)' }}>.</span>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginTop: 5, fontFamily: "'IBM Plex Mono', monospace" }}>
            split the bill, settle the tab, skip the awkward maths
          </div>
        </div>
        <button onClick={onRefresh} title="Pull latest from the group" aria-label="Refresh" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 9, border: '1.5px solid var(--line)', background: '#fff', color: 'var(--ink-soft)', cursor: 'pointer', flexShrink: 0 }}>
          <RefreshCw size={15} style={{ animation: refreshing ? 'ki-spin 0.8s linear infinite' : 'none' }} />
        </button>
      </div>
      <nav style={{ display: 'flex', gap: 4, borderBottom: '1.5px solid var(--line)', overflowX: 'auto' }}>
        {TABS.map(t => {
          const active = view === t.id;
          return (
            <button key={t.id} onClick={() => setView(t.id)} className="ki-tab" style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 13px 11px', background: 'transparent', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap', borderBottom: active ? '2.5px solid var(--stamp)' : '2.5px solid transparent', marginBottom: -1.5 }}>
              <t.icon size={15} style={{ color: active ? 'var(--ink)' : 'var(--ink-soft)' }} />
              <span style={{ fontFamily: "'Inter', sans-serif", fontWeight: 600, fontSize: 13.5, color: active ? 'var(--ink)' : 'var(--ink-soft)' }}>{t.label}</span>
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'var(--ink-soft)', opacity: 0.6 }}>{t.code}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

/* ----------------------------- People view ----------------------------- */

function PeopleView({ data, mutate, myId, setMyId }) {
  const [name, setName] = useState('');
  const [discordId, setDiscordId] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editDiscord, setEditDiscord] = useState('');
  const [error, setError] = useState('');

  const referencedIds = useMemo(() => {
    const s = new Set();
    data.bills.forEach(b => {
      if (b.payerId) s.add(b.payerId);
      (b.items || []).forEach(it => (it.assignments || []).forEach(a => s.add(a.personId)));
    });
    return s;
  }, [data.bills]);

  function addPerson() {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (data.roster.some(r => r.name.toLowerCase() === trimmed.toLowerCase())) {
      setError(`${trimmed} is already on the roster.`);
      return;
    }
    const next = { ...data, roster: [...data.roster, { id: uid(), name: trimmed, discordId: discordId.trim() }] };
    mutate(next);
    setName(''); setDiscordId(''); setError('');
  }

  function removePerson(id) {
    if (referencedIds.has(id)) return;
    mutate({ ...data, roster: data.roster.filter(r => r.id !== id) });
    if (myId === id) setMyId(null);
  }

  function startEdit(p) {
    setEditingId(p.id); setEditName(p.name); setEditDiscord(p.discordId || '');
  }
  function saveEdit() {
    const trimmed = editName.trim();
    if (!trimmed) return;
    mutate({
      ...data,
      roster: data.roster.map(r => r.id === editingId ? { ...r, name: trimmed, discordId: editDiscord.trim() } : r),
    });
    setEditingId(null);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="ki-card">
        <div className="ki-card-title">Add someone</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 9, alignItems: 'end' }}>
          <Field label="Name">
            <TextInput value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && addPerson()} placeholder="e.g. Darnish" />
          </Field>
          <Field label="Discord ID (optional)" hint="Lets the message actually @ping them">
            <TextInput value={discordId} onChange={e => setDiscordId(e.target.value.replace(/[^0-9]/g, ''))} onKeyDown={e => e.key === 'Enter' && addPerson()} placeholder="17–19 digit user ID" />
          </Field>
          <PrimaryButton onClick={addPerson} icon={UserPlus} disabled={!name.trim()}>Add</PrimaryButton>
        </div>
        {error && <div style={{ color: 'var(--owe)', fontSize: 12.5, marginTop: 8 }}>{error}</div>}
      </div>

      <div className="ki-card">
        <div className="ki-card-title">Who's checking this?</div>
        <div style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 10, lineHeight: 1.5 }}>
          Pick your name so the app knows who you are. This is saved just for you, not shared.
        </div>
        <select value={myId || ''} onChange={e => setMyId(e.target.value || null)} style={{ ...inputStyle, maxWidth: 280 }}>
          <option value="">— Select your name —</option>
          {data.roster.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>

      <div>
        <div className="ki-section-title">Roster ({data.roster.length})</div>
        {data.roster.length === 0 ? (
          <EmptyState icon={Users} title="Nobody added yet" body="Add everyone in the group above. Once they're on the roster, you can put them on bills and tag them in messages." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {data.roster.map(p => (
              <div key={p.id} className="ki-card" style={{ padding: '11px 14px' }}>
                {editingId === p.id ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto auto', gap: 8, alignItems: 'center' }}>
                    <TextInput value={editName} onChange={e => setEditName(e.target.value)} autoFocus />
                    <TextInput value={editDiscord} onChange={e => setEditDiscord(e.target.value.replace(/[^0-9]/g, ''))} placeholder="Discord ID" />
                    <GhostButton onClick={saveEdit}>Save</GhostButton>
                    <IconButton icon={X} label="Cancel" onClick={() => setEditingId(null)} />
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                      <div style={{ width: 30, height: 30, borderRadius: 999, background: 'var(--paper-dim)', border: '1.5px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 12.5, color: 'var(--ink-soft)', flexShrink: 0 }}>{p.name.slice(0, 1).toUpperCase()}</div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 6 }}>
                          {p.name}
                          {myId === p.id && <span style={{ fontSize: 10.5, color: 'var(--stamp)', fontWeight: 700 }}>YOU</span>}
                        </div>
                        {p.discordId ? (
                          <div style={{ fontSize: 11.5, color: 'var(--ink-soft)', fontFamily: "'IBM Plex Mono', monospace", display: 'flex', alignItems: 'center', gap: 3 }}>
                            <AtSign size={10} /> {p.discordId}
                          </div>
                        ) : (
                          <div style={{ fontSize: 11.5, color: 'var(--ink-soft)', opacity: 0.6 }}>no Discord ID saved</div>
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      <IconButton icon={Pencil} label="Edit" onClick={() => startEdit(p)} />
                      <IconButton icon={Trash2} label="Remove" danger onClick={() => removePerson(p.id)} disabled={referencedIds.has(p.id)} style={referencedIds.has(p.id) ? { opacity: 0.3, cursor: 'not-allowed' } : {}} />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- New Bill view ----------------------------- */

function emptyDraft() {
  return {
    title: '', date: todayISO(), payerId: '', items: [],
    taxRate: DEFAULT_TAX, serviceRate: DEFAULT_SERVICE, receiptTotal: '',
  };
}

function NewBillView({ data, mutate, myId, goToLedger }) {
  const [draft, setDraft] = useState(emptyDraft);
  const [justSaved, setJustSaved] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!draft.payerId && myId) setDraft(d => ({ ...d, payerId: myId }));
  }, [myId]);

  function addItem() {
    setDraft(d => ({ ...d, items: [...d.items, { id: uid(), name: '', unitPrice: '', quantity: 1, assignments: [] }] }));
  }

  function removeItem(itemId) {
    setDraft(d => ({ ...d, items: d.items.filter(it => it.id !== itemId) }));
  }

  function updateItem(itemId, patch) {
    setDraft(d => ({ ...d, items: d.items.map(it => it.id === itemId ? { ...it, ...patch } : it) }));
  }

  function toggleParticipant(itemId, personId) {
    setDraft(d => ({
      ...d,
      items: d.items.map(it => {
        if (it.id !== itemId) return it;
        const exists = it.assignments.some(a => a.personId === personId);
        let assignments = exists
          ? it.assignments.filter(a => a.personId !== personId)
          : [...it.assignments, { personId, amount: 0 }];
        const lineTotal = round2((Number(it.unitPrice) || 0) * (Number(it.quantity) || 1));
        const n = assignments.length;
        if (n > 0) {
          const each = round2(lineTotal / n);
          let running = 0;
          assignments = assignments.map((a, idx) => {
            if (idx === n - 1) return { ...a, amount: round2(lineTotal - running) };
            running = round2(running + each);
            return { ...a, amount: each };
          });
        }
        return { ...it, assignments };
      }),
    }));
  }

  function setAssignmentAmount(itemId, personId, value) {
    setDraft(d => ({
      ...d,
      items: d.items.map(it => it.id !== itemId ? it : {
        ...it,
        assignments: it.assignments.map(a => a.personId === personId ? { ...a, amount: value === '' ? 0 : parseFloat(value) } : a),
      }),
    }));
  }

  const handleScanReceipt = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setIsScanning(true);
    try {
      const { data: { text } } = await Tesseract.recognize(file, 'eng');
      const lines = text.split('\n');
      const scannedItems = [];

      lines.forEach(line => {
        const match = line.match(/(.+?)\s+([\d]+\.\d{2})$/);
        if (match && !line.toLowerCase().includes('total') && !line.toLowerCase().includes('tax') && !line.toLowerCase().includes('cash')) {
          scannedItems.push({
            id: uid(),
            name: match[1].trim().replace(/[^a-zA-Z0-9 ]/g, ''),
            unitPrice: match[2],
            quantity: 1,
            assignments: []
          });
        }
      });

      if (scannedItems.length > 0) {
        setDraft(d => ({ ...d, items: [...d.items, ...scannedItems] }));
      } else {
        alert("Could not automatically detect items/prices from this receipt. Try taking a clearer picture.");
      }
    } catch (err) {
      console.error("OCR Error:", err);
      alert("Failed to scan receipt. Please enter items manually.");
    }
    setIsScanning(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const summary = useMemo(() => computeBill({
    items: draft.items.map(it => ({ ...it, unitPrice: Number(it.unitPrice) || 0, quantity: Number(it.quantity) || 1 })),
    taxRate: Number(draft.taxRate) || 0,
    serviceRate: Number(draft.serviceRate) || 0,
    receiptTotal: draft.receiptTotal,
    payments: [],
  }), [draft]);

  const itemIssues = draft.items.filter(it => {
    const lineTotal = round2((Number(it.unitPrice) || 0) * (Number(it.quantity) || 1));
    const allocated = round2((it.assignments || []).reduce((s, a) => s + (a.amount || 0), 0));
    return it.assignments.length > 0 && Math.abs(lineTotal - allocated) > 0.02;
  });

  const canFinalize = draft.payerId
    && draft.items.length > 0
    && draft.items.every(it => it.name.trim() && Number(it.unitPrice) > 0 && it.assignments.length > 0)
    && itemIssues.length === 0;

  function finalizeBill() {
    if (!canFinalize) return;
    const bill = {
      id: uid(),
      title: draft.title.trim() || `Dinner — ${niceDate(draft.date)}`,
      date: draft.date,
      payerId: draft.payerId,
      items: draft.items.map(it => ({
        id: it.id, name: it.name.trim(), unitPrice: Number(it.unitPrice) || 0,
        quantity: Number(it.quantity) || 1, assignments: it.assignments,
      })),
      taxRate: Number(draft.taxRate) || 0,
      serviceRate: Number(draft.serviceRate) || 0,
      receiptTotal: draft.receiptTotal === '' ? null : Number(draft.receiptTotal),
      payments: [],
      createdAt: Date.now(),
    };
    mutate({ ...data, bills: [bill, ...data.bills] });
    setDraft(emptyDraft());
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 2600);
  }

  if (data.roster.length === 0) {
    return <EmptyState icon={Receipt} title="Add people first" body="Head to the People tab and add everyone who was at dinner before you start splitting a bill." />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="ki-card">
        <div className="ki-card-title">Bill details</div>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10, marginBottom: 10 }}>
          <Field label="Title (optional)">
            <TextInput value={draft.title} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} placeholder="e.g. Sushi after work" />
          </Field>
          <Field label="Date">
            <TextInput type="date" value={draft.date} onChange={e => setDraft(d => ({ ...d, date: e.target.value }))} />
          </Field>
        </div>
        <Field label="Who paid the restaurant?" hint="Everyone else's share owes this person">
          <select value={draft.payerId} onChange={e => setDraft(d => ({ ...d, payerId: e.target.value }))} style={inputStyle}>
            <option value="">— Select payer —</option>
            {data.roster.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </Field>
      </div>

      <div className="ki-card receipt-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div className="ki-card-title" style={{ marginBottom: 0 }}>Items</div>
          <GhostButton icon={Camera} onClick={() => fileInputRef.current?.click()} disabled={isScanning}>
            {isScanning ? 'Scanning...' : 'Scan Receipt'}
          </GhostButton>
          <input type="file" accept="image/*" ref={fileInputRef} onChange={handleScanReceipt} style={{ display: 'none' }} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {draft.items.map((it, idx) => {
            const lineTotal = round2((Number(it.unitPrice) || 0) * (Number(it.quantity) || 1));
            const allocated = round2((it.assignments || []).reduce((s, a) => s + (a.amount || 0), 0));
            const diff = round2(lineTotal - allocated);
            return (
              <div key={it.id} className="receipt-line" style={{ paddingTop: idx === 0 ? 0 : 14 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 64px 30px', gap: 8, alignItems: 'end', marginBottom: 9 }}>
                  <Field label="Item">
                    <TextInput value={it.name} onChange={e => updateItem(it.id, { name: e.target.value })} placeholder="e.g. Chicken Katsu Don" />
                  </Field>
                  <Field label="Price (RM)">
                    <NumberInput value={it.unitPrice} min="0" step="0.01" onChange={e => updateItem(it.id, { unitPrice: e.target.value })} placeholder="0.00" />
                  </Field>
                  <Field label="Qty">
                    <NumberInput value={it.quantity} min="1" step="1" onChange={e => updateItem(it.id, { quantity: e.target.value })} />
                  </Field>
                  <IconButton icon={Trash2} label="Remove item" danger onClick={() => removeItem(it.id)} />
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: it.assignments.length ? 8 : 0 }}>
                  {data.roster.map(p => {
                    const on = it.assignments.some(a => a.personId === p.id);
                    return (
                      <button key={p.id} onClick={() => toggleParticipant(it.id, p.id)} className="ki-chip" style={{ padding: '5px 11px', borderRadius: 999, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: on ? '1.5px solid var(--ink)' : '1.5px solid var(--line)', background: on ? 'var(--ink)' : '#fff', color: on ? 'var(--paper)' : 'var(--ink-soft)' }}>
                        {p.name}
                      </button>
                    );
                  })}
                </div>

                {it.assignments.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {it.assignments.map(a => (
                      <div key={a.personId} className="leader-row" style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                        <span style={{ fontSize: 12.5, color: 'var(--ink-soft)', minWidth: 70 }}>{personName(data.roster, a.personId)}</span>
                        <span className="dot-leader" />
                        <input type="number" step="0.01" value={a.amount} aria-label={`${personName(data.roster, a.personId)}'s share of ${it.name || 'this item'}`} onChange={e => setAssignmentAmount(it.id, a.personId, e.target.value)} style={{ width: 78, padding: '4px 7px', borderRadius: 7, border: '1.5px solid var(--line)', fontFamily: "'IBM Plex Mono', monospace", fontSize: 12.5, textAlign: 'right', background: '#fff', color: 'var(--ink)' }} />
                      </div>
                    ))}
                    {Math.abs(diff) > 0.02 && (
                      <div style={{ fontSize: 11.5, color: 'var(--owe)', marginTop: 2 }}>
                        RM {Math.abs(diff).toFixed(2)} {diff > 0 ? 'left to allocate' : 'over-allocated'} — line total is {fmt(lineTotal)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <button onClick={addItem} className="ki-add-item" style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 6, padding: '9px 13px', borderRadius: 9, border: '1.5px dashed var(--line)', background: 'transparent', color: 'var(--ink-soft)', fontWeight: 600, fontSize: 13.5, cursor: 'pointer', width: '100%', justifyContent: 'center' }}>
          <Plus size={15} /> Add item
        </button>
      </div>

      <div className="ki-card">
        <div className="ki-card-title">Tax, service & rounding</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <Field label="Service tax %">
            <NumberInput value={draft.taxRate} min="0" step="0.1" onChange={e => setDraft(d => ({ ...d, taxRate: e.target.value }))} />
          </Field>
          <Field label="Service charge %">
            <NumberInput value={draft.serviceRate} min="0" step="0.1" onChange={e => setDraft(d => ({ ...d, serviceRate: e.target.value }))} />
          </Field>
          <Field label="Receipt total (optional)" hint="Catches odd rounding">
            <NumberInput value={draft.receiptTotal} min="0" step="0.01" placeholder="0.00" onChange={e => setDraft(d => ({ ...d, receiptTotal: e.target.value }))} />
          </Field>
        </div>
      </div>

      {Object.keys(summary.perPerson).length > 0 && (
        <div className="ki-card receipt-card">
          <div className="ki-card-title">Running total</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {Object.entries(summary.perPerson).map(([pid, p]) => (
              <div key={pid} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 13.5 }}>
                <span style={{ fontWeight: 600, color: 'var(--ink)' }}>
                  {personName(data.roster, pid)}{pid === draft.payerId && <span style={{ color: 'var(--stamp)', fontSize: 10.5, marginLeft: 6, fontWeight: 700 }}>PAYER</span>}
                </span>
                <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600, color: 'var(--ink)' }}>{fmt(p.totalOwed)}</span>
              </div>
            ))}
            <div className="receipt-divider" />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14.5, fontWeight: 700 }}>
              <span>Bill total</span>
              <span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmt(summary.grandTotal)}</span>
            </div>
            {Math.abs(summary.roundingAdj) >= 0.01 && (
              <div style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>
                RM {Math.abs(summary.roundingAdj).toFixed(2)} {summary.roundingAdj > 0 ? 'under' : 'over'} your receipt total — that'll just sit with the payer, no need to chase cents.
              </div>
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <PrimaryButton onClick={finalizeBill} icon={ClipboardCheck} disabled={!canFinalize}>Save bill</PrimaryButton>
        {!canFinalize && draft.items.length > 0 && (
          <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
            {itemIssues.length > 0 ? 'Finish allocating every item first.' : 'Every item needs a name, price, and at least one person on it.'}
          </span>
        )}
        {justSaved && (
          <span style={{ fontSize: 13, color: 'var(--settled)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5 }}>
            <Check size={15} /> Saved — check the Ledger
          </span>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- Ledger view ----------------------------- */

function PaymentForm({ roster, bill, onAdd }) {
  const [personId, setPersonId] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('Cash');
  const [note, setNote] = useState('');
  const debtors = roster.filter(r => r.id !== bill.payerId);

  function submit() {
    if (!personId || !amount || Number(amount) <= 0) return;
    onAdd({ id: uid(), personId, amount: round2(Number(amount)), method, note: note.trim(), date: todayISO() });
    setAmount(''); setNote('');
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 100px 1fr auto', gap: 7, alignItems: 'end' }}>
      <Field label="Who paid">
        <select value={personId} onChange={e => setPersonId(e.target.value)} style={inputStyle}>
          <option value="">Select…</option>
          {debtors.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </Field>
      <Field label="Amount">
        <NumberInput value={amount} min="0" step="0.01" placeholder="0.00" onChange={e => setAmount(e.target.value)} />
      </Field>
      <Field label="Method">
        <select value={method} onChange={e => setMethod(e.target.value)} style={inputStyle}>
          <option>Cash</option><option>TNG</option><option>Bank transfer</option><option>Other</option>
        </select>
      </Field>
      <Field label="Note (optional)">
        <TextInput value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. paid the rest later" />
      </Field>
      <GhostButton onClick={submit} icon={Plus} disabled={!personId || !amount}>Log</GhostButton>
    </div>
  );
}

function BillRow({ bill, roster, onAddPayment, onDelete, onMessageThis }) {
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => computeBill(bill), [bill]);
  const settled = isBillSettled(bill);

  return (
    <div className="ki-card receipt-card">
      <button onClick={() => setOpen(o => !o)} style={{ all: 'unset', display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', cursor: 'pointer', boxSizing: 'border-box' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14.5, color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {bill.title}
            <StampBadge kind={settled ? 'settled' : 'owing'}>{settled ? 'Settled' : 'Outstanding'}</StampBadge>
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 3, fontFamily: "'IBM Plex Mono', monospace" }}>
            {niceDate(bill.date)} · paid by {personName(roster, bill.payerId)} · {fmt(summary.grandTotal)}
          </div>
        </div>
        {open ? <ChevronUp size={18} color="var(--ink-soft)" /> : <ChevronDown size={18} color="var(--ink-soft)" />}
      </button>

      {open && (
        <div style={{ marginTop: 16 }}>
          <div className="receipt-divider" style={{ marginBottom: 12 }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 14 }}>
            {bill.items.map(it => (
              <div key={it.id} className="leader-row" style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12.5 }}>
                <span style={{ color: 'var(--ink-soft)' }}>{it.name}{it.quantity > 1 ? ` ×${it.quantity}` : ''}</span>
                <span className="dot-leader" />
                <span style={{ fontFamily: "'IBM Plex Mono', monospace", color: 'var(--ink)' }}>{fmt(it.unitPrice * it.quantity)}</span>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginBottom: 14 }}>
            {Object.entries(summary.perPerson).map(([pid, p]) => (
              <div key={pid} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 11px', borderRadius: 9, background: 'var(--paper-dim)', fontSize: 13 }}>
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--ink)' }}>
                    {personName(roster, pid)} {pid === bill.payerId && <span style={{ fontSize: 10, color: 'var(--stamp)', fontWeight: 700 }}>PAYER</span>}
                  </div>
                  {pid !== bill.payerId && (
                    <div style={{ fontSize: 11, color: 'var(--ink-soft)', fontFamily: "'IBM Plex Mono', monospace" }}>
                      food {fmt(p.subtotal)} + tax {fmt(p.tax)} + service {fmt(p.service)}
                      {p.paid > 0 && ` · paid ${fmt(p.paid)}`}
                    </div>
                  )}
                </div>
                {pid !== bill.payerId && (
                  <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, color: round2(p.remaining) <= 0.004 ? 'var(--settled)' : 'var(--owe)' }}>
                    {round2(p.remaining) <= 0.004 ? 'Paid' : fmt(p.remaining)}
                  </span>
                )}
              </div>
            ))}
          </div>

          {!settled && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 7 }}>
                Log a payment
              </div>
              <PaymentForm roster={roster} bill={bill} onAdd={(p) => onAddPayment(bill.id, p)} />
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <GhostButton icon={MessageSquare} onClick={() => onMessageThis(bill.id)}>Draft a message</GhostButton>
            <GhostButton icon={Trash2} onClick={() => onDelete(bill.id)} style={{ color: 'var(--owe)', borderColor: 'var(--owe-bg)' }}>Delete</GhostButton>
          </div>
        </div>
      )}
    </div>
  );
}

function QRCodeModal({ payerName, amount, onClose }) {
  const payload = `DuitNow_Transfer_To_${encodeURIComponent(payerName)}_RM${amount}`;
  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }} onClick={onClose}>
      <div className="ki-card" style={{ padding: 24, textAlign: 'center', width: 280 }} onClick={e => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>Pay {payerName}</div>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 24, color: 'var(--stamp)', fontWeight: 700, marginBottom: 16 }}>{fmt(amount)}</div>
        <div style={{ background: '#fff', padding: 12, border: '1.5px solid var(--line)', borderRadius: 12, display: 'inline-block', marginBottom: 16 }}>
          {/* Using public QR API to dynamically generate DuitNow/TNG placeholder */}
          <img src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${payload}`} alt="DuitNow QR Code" style={{ display: 'block', width: 200, height: 200 }} />
        </div>
        <GhostButton onClick={onClose} style={{ width: '100%', justifyContent: 'center' }}>Close</GhostButton>
      </div>
    </div>
  );
}

function LedgerView({ data, mutate, roster, goToMessage }) {
  const ledger = useMemo(() => computeLedger(data), [data]);
  const [activeQR, setActiveQR] = useState(null);

  function addPayment(billId, payment) {
    mutate({ ...data, bills: data.bills.map(b => b.id === billId ? { ...b, payments: [...(b.payments || []), payment] } : b) });
  }

  function deleteBill(billId) {
    mutate({ ...data, bills: data.bills.filter(b => b.id !== billId) });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {activeQR && <QRCodeModal payerName={activeQR.name} amount={activeQR.amount} onClose={() => setActiveQR(null)} />}

      <div>
        <div className="ki-section-title">Who owes who</div>
        {ledger.length === 0 ? (
          <EmptyState icon={Wallet} title="All settled up" body="No outstanding balances right now. Once you save a bill, anything owed will show up here." />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
            {ledger.map(p => {
              const payerName = personName(roster, p.payerId);
              return (
                <div key={`${p.debtorId}__${p.payerId}`} className="ki-card" style={{ padding: '13px 15px' }}>
                  <div style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
                    <strong style={{ color: 'var(--ink)' }}>{personName(roster, p.debtorId)}</strong> owes <strong style={{ color: 'var(--ink)' }}>{payerName}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 5 }}>
                    <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, fontSize: 19, color: 'var(--owe)' }}>
                      {fmt(p.amount)}
                    </div>
                    <IconButton icon={QrCode} label="Show QR to Pay" onClick={() => setActiveQR({ name: payerName, amount: p.amount })} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <div className="ki-section-title">Bills ({data.bills.length})</div>
        {data.bills.length === 0 ? (
          <EmptyState icon={Receipt} title="No bills yet" body="Split your first one in the New Bill tab — it'll show up here once it's saved." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[...data.bills].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(bill => (
              <BillRow key={bill.id} bill={bill} roster={roster} onAddPayment={addPayment} onDelete={deleteBill} onMessageThis={goToMessage} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- Message view ----------------------------- */

const TONE_COPY = {
  polite: { label: 'Polite', plea: "If you get a chance, please settle this up whenever's convenient — thank you!" },
  default: { label: 'Default', plea: "Please settle up when you get a chance — let's not let this drag on." },
  savage: { label: 'Savage', plea: 'Failure to settle within the deadline below will result in **public reminders** until this is resolved.' },
};

function buildMessage({ title, scopeLines, totalOwed, deadline, tone, extraNotes, signOff }) {
  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  const mentionList = scopeLines.map(l => l.mentionToken).join(' ');
  lines.push(`Hey ${mentionList},`);
  lines.push('');
  lines.push(TONE_COPY[tone].plea);
  lines.push('');
  scopeLines.forEach(l => {
    lines.push(`**${l.name}** — RM ${l.remaining.toFixed(2)}`);
    lines.push(`-# ${l.breakdown}`);
  });
  lines.push('');
  lines.push(`**Total outstanding: RM ${totalOwed.toFixed(2)}**`);
  lines.push('');
  if (deadline.trim()) lines.push(`Please settle within **${deadline.trim()}**.`);
  if (extraNotes.trim()) { lines.push(''); lines.push(extraNotes.trim()); }
  lines.push('');
  lines.push('Kind regards,');
  lines.push(`-# ${signOff.trim() || 'Whoever paid'}`);
  return lines.join('\n');
}

function MessagePreview({ text }) {
  const renderInline = (s) => {
    const parts = s.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((p, i) => p.startsWith('**') && p.endsWith('**') ? <strong key={i} style={{ fontWeight: 700 }}>{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>);
  };
  return (
    <div style={{ background: 'var(--discord-bg)', borderRadius: 12, padding: '16px 18px', fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, lineHeight: 1.7, color: '#DBDEE1', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {text.split('\n').map((line, i) => {
        if (line.startsWith('# ')) return <div key={i} style={{ fontWeight: 700, fontSize: 16, color: '#fff', marginBottom: 2 }}>{line.slice(2)}</div>;
        if (line.startsWith('-# ')) return <div key={i} style={{ fontSize: 11.5, color: '#949BA4' }}>{renderInline(line.slice(3))}</div>;
        if (line.trim() === '') return <div key={i} style={{ height: 8 }} />;
        return <div key={i}>{renderInline(line)}</div>;
      })}
    </div>
  );
}

function MessageView({ data, roster, presetBillId }) {
  const billsWithBalance = useMemo(() => data.bills.filter(b => !isBillSettled(b)), [data.bills]);
  const ledger = useMemo(() => computeLedger(data), [data]);
  const payerOptions = useMemo(() => {
    const ids = new Set(ledger.map(p => p.payerId));
    return roster.filter(r => ids.has(r.id));
  }, [ledger, roster]);

  const [scopeType, setScopeType] = useState(presetBillId ? 'bill' : (billsWithBalance[0] ? 'bill' : 'payer'));
  const [billId, setBillId] = useState(presetBillId || (billsWithBalance[0] ? billsWithBalance[0].id : ''));
  const [payerId, setPayerId] = useState(payerOptions[0] ? payerOptions[0].id : '');
  const [title, setTitle] = useState('Dinner Receipt');
  const [deadline, setDeadline] = useState('3 days');
  const [tone, setTone] = useState('default');
  const [extraNotes, setExtraNotes] = useState('');
  const [signOff, setSignOff] = useState('');

  const [webhookUrl, setWebhookUrl] = useState('');
  const [sendingWebhook, setSendingWebhook] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => { if (presetBillId) { setScopeType('bill'); setBillId(presetBillId); } }, [presetBillId]);

  useEffect(() => {
    if (scopeType === 'bill' && billId) {
      const b = data.bills.find(x => x.id === billId);
      if (b) setTitle(b.title);
      if (b) setSignOff(personName(roster, b.payerId));
    } else if (scopeType === 'payer' && payerId) {
      setTitle('Outstanding Balances');
      setSignOff(personName(roster, payerId));
    }
  }, [scopeType, billId, payerId]);

  const scopeLines = useMemo(() => {
    if (scopeType === 'bill') {
      const bill = data.bills.find(b => b.id === billId);
      if (!bill) return [];
      const { perPerson } = computeBill(bill);
      return Object.entries(perPerson)
        .filter(([pid, p]) => pid !== bill.payerId && round2(p.remaining) > 0.004)
        .map(([pid, p]) => {
          const person = roster.find(r => r.id === pid);
          return {
            name: person ? person.name : 'Unknown',
            mentionToken: person && person.discordId ? `<@${person.discordId}>` : `@${person ? person.name : 'Unknown'}`,
            remaining: p.remaining,
            breakdown: `food ${fmt(p.subtotal)} + tax ${fmt(p.tax)} + service ${fmt(p.service)}${p.paid > 0 ? ` · already paid ${fmt(p.paid)}` : ''}`,
          };
        });
    }
    return ledger.filter(p => p.payerId === payerId).map(p => {
      const person = roster.find(r => r.id === p.debtorId);
      return {
        name: person ? person.name : 'Unknown',
        mentionToken: person && person.discordId ? `<@${person.discordId}>` : `@${person ? person.name : 'Unknown'}`,
        remaining: p.amount,
        breakdown: `across ${p.billIds.length} bill${p.billIds.length === 1 ? '' : 's'}`,
      };
    });
  }, [scopeType, billId, payerId, data.bills, ledger, roster]);

  const totalOwed = round2(scopeLines.reduce((s, l) => s + l.remaining, 0));
  const messageText = useMemo(() => buildMessage({ title: title || 'Dinner Receipt', scopeLines, totalOwed, deadline, tone, extraNotes, signOff }),
    [title, scopeLines, totalOwed, deadline, tone, extraNotes, signOff]);

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(messageText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) { }
  }

  async function sendToDiscordWebhook() {
    if (!webhookUrl) return alert('Please enter a Discord Webhook URL first.');
    setSendingWebhook(true);
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: messageText })
      });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      alert("Successfully sent to Discord!");
    } catch (e) {
      alert("Failed to send webhook: " + e.message);
    }
    setSendingWebhook(false);
  }

  if (data.bills.length === 0) {
    return <EmptyState icon={MessageSquare} title="Nothing to message yet" body="Save a bill first, then come back here to draft the nag." />;
  }
  if (scopeLines.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <ScopePicker {...{ scopeType, setScopeType, billsWithBalance, billId, setBillId, payerOptions, payerId, setPayerId, roster }} />
        <EmptyState icon={Check} title="Nothing outstanding here" body="Everyone in this scope is already settled up — pick a different bill or payer above." />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <ScopePicker {...{ scopeType, setScopeType, billsWithBalance, billId, setBillId, payerOptions, payerId, setPayerId, roster }} />

      <div className="ki-card">
        <div className="ki-card-title">Message details</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
          <Field label="Title">
            <TextInput value={title} onChange={e => setTitle(e.target.value)} />
          </Field>
          <Field label="Deadline">
            <TextInput value={deadline} onChange={e => setDeadline(e.target.value)} placeholder="e.g. 3 days" />
          </Field>
        </div>
        <Field label="Tone">
          <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
            {Object.entries(TONE_COPY).map(([key, t]) => (
              <button key={key} onClick={() => setTone(key)} style={{ padding: '7px 13px', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: tone === key ? '1.5px solid var(--ink)' : '1.5px solid var(--line)', background: tone === key ? 'var(--ink)' : '#fff', color: tone === key ? 'var(--paper)' : 'var(--ink-soft)' }}>{t.label}</button>
            ))}
          </div>
        </Field>
        <div style={{ height: 10 }} />
        <Field label="Extra notes (optional)" hint="Your own jokes, threats, or context go here — not auto-generated">
          <textarea value={extraNotes} onChange={e => setExtraNotes(e.target.value)} rows={3} placeholder="e.g. specific inside jokes about who keeps forgetting to pay…" style={{ ...inputStyle, fontFamily: "'Inter', sans-serif", resize: 'vertical' }} />
        </Field>
        <div style={{ height: 10 }} />
        <Field label="Sign-off name">
          <TextInput value={signOff} onChange={e => setSignOff(e.target.value)} />
        </Field>
      </div>

      <div className="ki-card">
        <div className="ki-card-title">Discord Webhook Integration</div>
        <Field label="Webhook URL" hint="Paste your Discord channel webhook URL here to send directly">
          <TextInput value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)} placeholder="https://discord.com/api/webhooks/..." />
        </Field>
      </div>

      <div>
        <div className="ki-card-title" style={{ marginBottom: 8 }}>Preview</div>
        <MessagePreview text={messageText} />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 16 }}>
          <GhostButton onClick={copyMessage} icon={copied ? Check : Copy} style={{ justifyContent: 'center' }}>
            {copied ? 'Copied to clipboard' : 'Copy Message'}
          </GhostButton>
          <PrimaryButton onClick={sendToDiscordWebhook} icon={Send} loading={sendingWebhook} disabled={!webhookUrl}>
            Send to Discord
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

function ScopePicker({ scopeType, setScopeType, billsWithBalance, billId, setBillId, payerOptions, payerId, setPayerId, roster }) {
  return (
    <div className="ki-card">
      <div className="ki-card-title">Who's this message for</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <button onClick={() => setScopeType('bill')} disabled={billsWithBalance.length === 0} style={{ padding: '7px 13px', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: billsWithBalance.length === 0 ? 'not-allowed' : 'pointer', border: scopeType === 'bill' ? '1.5px solid var(--ink)' : '1.5px solid var(--line)', background: scopeType === 'bill' ? 'var(--ink)' : '#fff', color: scopeType === 'bill' ? 'var(--paper)' : 'var(--ink-soft)', opacity: billsWithBalance.length === 0 ? 0.4 : 1 }}>One bill</button>
        <button onClick={() => setScopeType('payer')} disabled={payerOptions.length === 0} style={{ padding: '7px 13px', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: payerOptions.length === 0 ? 'not-allowed' : 'pointer', border: scopeType === 'payer' ? '1.5px solid var(--ink)' : '1.5px solid var(--line)', background: scopeType === 'payer' ? 'var(--ink)' : '#fff', color: scopeType === 'payer' ? 'var(--paper)' : 'var(--ink-soft)', opacity: payerOptions.length === 0 ? 0.4 : 1 }}>Everything owed to someone</button>
      </div>
      {scopeType === 'bill' ? (
        <select value={billId} onChange={e => setBillId(e.target.value)} style={inputStyle}>
          {billsWithBalance.map(b => <option key={b.id} value={b.id}>{b.title} — {niceDate(b.date)}</option>)}
        </select>
      ) : (
        <select value={payerId} onChange={e => setPayerId(e.target.value)} style={inputStyle}>
          {payerOptions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
    </div>
  );
}

/* ----------------------------- App shell ----------------------------- */

export default function App() {
  const [data, setData] = useState(emptyData());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [myId, setMyIdState] = useState(null);
  const [view, setView] = useState('ledger');
  const [storageOk, setStorageOk] = useState(true);
  const [messagePresetBill, setMessagePresetBill] = useState(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const d = await loadData();
    setData(d);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (typeof window === 'undefined' || !window.storage) setStorageOk(false);
      const [d, identity] = await Promise.all([loadData(), loadIdentity()]);
      if (!cancelled) { setData(d); setMyIdState(identity); setLoading(false); }
    })();
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; window.removeEventListener('focus', onFocus); };
  }, [refresh]);

  const mutate = useCallback((next) => {
    setData(next);
    persistData(next);
  }, []);

  const setMyId = useCallback((id) => {
    setMyIdState(id);
    persistIdentity(id);
  }, []);

  function goToMessage(billId) {
    setMessagePresetBill(billId);
    setView('message');
  }
  function goToLedger() { setView('ledger'); }

  return (
    <div style={{ background: 'var(--paper)', minHeight: '100%', padding: '20px 16px 60px' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

        :root {
          --paper: #F6F1E4; --paper-dim: #ECE4D0; --ink: #211D18; --ink-soft: #5C5448;
          --owe: #A8361F; --owe-bg: #F4DCD3; --settled: #2E5C3E; --settled-bg: #DCE8DD;
          --stamp: #C97A14; --line: #D8CDB4; --discord-bg: #313338;
        }
        * { box-sizing: border-box; }
        .ki-card { background: #fff; border: 1.5px solid var(--line); border-radius: 14px; padding: 16px; }
        .ki-card-title { font-family: 'Space Grotesk', sans-serif; font-weight: 600; font-size: 14.5px; color: var(--ink); margin-bottom: 12px; }
        .ki-section-title { font-family: 'Space Grotesk', sans-serif; font-weight: 600; font-size: 13px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 10px; }
        .ki-input:focus, select:focus, textarea:focus { border-color: var(--ink) !important; outline: 2px solid var(--stamp); outline-offset: 1px; }
        button:focus-visible { outline: 2px solid var(--stamp); outline-offset: 2px; }
        .ki-tab:hover span { color: var(--ink) !important; }
        .ki-add-item:hover { border-color: var(--ink) !important; color: var(--ink) !important; }
        .ki-chip:hover { border-color: var(--ink) !important; }
        .dot-leader { flex: 1; border-bottom: 1.5px dotted var(--line); margin-bottom: 4px; min-width: 16px; }
        .receipt-divider { border-top: 1.5px dashed var(--line); }
        .receipt-line + .receipt-line { border-top: 1px dashed var(--line); }
        .stamp-badge { transform: rotate(-1.5deg); }
        ::placeholder { color: var(--ink-soft); opacity: 0.45; }
        select { width: 100%; padding: 9px 11px; border-radius: 9px; border: 1.5px solid var(--line); background: #fff; color: var(--ink); font-size: 14px; font-family: 'Inter', sans-serif; }
        textarea { font-size: 14px; }
        @keyframes ki-spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
      `}</style>

      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <Header view={view} setView={setView} onRefresh={refresh} refreshing={refreshing} />

        {!storageOk && (
          <div style={{ padding: '10px 14px', borderRadius: 10, background: 'var(--owe-bg)', color: 'var(--owe)', fontSize: 12.5, marginBottom: 16 }}>
            Storage isn't available in this preview, so nothing will be saved. Open this from a regular conversation to keep your data.
          </div>
        )}

        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, color: 'var(--ink-soft)', fontSize: 14, padding: '40px 0', justifyContent: 'center' }}>
            <Loader2 size={17} style={{ animation: 'ki-spin 0.8s linear infinite' }} /> Loading the tab…
          </div>
        ) : (
          <>
            {view === 'ledger' && <LedgerView data={data} mutate={mutate} roster={data.roster} goToMessage={goToMessage} />}
            {view === 'newbill' && <NewBillView data={data} mutate={mutate} myId={myId} goToLedger={goToLedger} />}
            {view === 'people' && <PeopleView data={data} mutate={mutate} myId={myId} setMyId={setMyId} />}
            {view === 'message' && <MessageView data={data} roster={data.roster} presetBillId={messagePresetBill} />}
          </>
        )}
      </div>
    </div>
  );
}