import { auth, db, googleProvider } from './firebase';
import { signInWithPopup, onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import Tesseract from 'tesseract.js';
import {
  Users, Receipt, Plus, Trash2, Wallet, Copy, Check,
  ChevronDown, ChevronUp, X, Pencil, ArrowRight, Loader2, RefreshCw,
  UserPlus, ClipboardCheck, Camera, QrCode
} from 'lucide-react';

/* ----------------------------- helpers ----------------------------- */
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
async function loadData(userId) {
  if (!userId) return emptyData();
  try {
    const docSnap = await getDoc(doc(db, "users", userId));
    if (docSnap.exists()) {
      const parsed = docSnap.data();
      return { roster: parsed.roster || [], bills: parsed.bills || [] };
    }
  } catch (e) { console.error(e); }
  return emptyData();
}

async function persistData(userId, data) {
  if (!userId) return;
  try {
    await setDoc(doc(db, "users", userId), data);
  } catch (e) { console.error(e); }
}

function personName(roster, id) {
  const p = roster.find(r => r.id === id);
  return p ? p.name : 'Unknown';
}
const isPaymentCounted = (pm) => pm.status !== 'pending';

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

    // Separate approved payments from pending verifications
    const approvedPayments = (bill.payments || []).filter(pm => pm.personId === pid && isPaymentCounted(pm));
    const pendingPayments = (bill.payments || []).filter(pm => pm.personId === pid && !isPaymentCounted(pm));

    p.paid = round2(approvedPayments.reduce((s, pm) => s + (pm.amount || 0), 0));
    p.remaining = round2(p.totalOwed - p.paid);
    p.pendingPayments = pendingPayments; // Attached for UI rendering
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
    <span className="stamp-badge" style={{ ...styles, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 9px', borderRadius: 5, border: '1.5px dashed', fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', whiteSpace: 'nowrap', transform: 'rotate(-2deg)' }}>
      {children}
    </span>
  );
}

function EmptyState({ icon: Icon, title, body, action }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 24px', border: '1.5px dashed var(--line)', borderRadius: '16px', background: 'var(--paper-dim)' }}>
      <div style={{ background: 'var(--stamp-bg)', width: 48, height: 48, borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px auto' }}>
        <Icon size={24} strokeWidth={2} style={{ color: 'var(--stamp)' }} />
      </div>
      <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--ink)', fontFamily: "'Space Grotesk', sans-serif" }}>{title}</div>
      <div style={{ color: 'var(--ink-soft)', fontSize: 14, marginTop: 6, maxWidth: 320, marginInline: 'auto', lineHeight: 1.5 }}>{body}</div>
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
  { id: 'people', label: 'People', code: 'PP-03', icon: Users }
];

function Header({ view, setView, onRefresh, refreshing, authUser, onSignOut }) {
  return (
    <div style={{ marginBottom: 24, textAlign: 'center' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 20 }}>

        {/* Profile & Refresh - Updated for better visibility */}
        <div style={{ display: 'flex', width: '100%', maxWidth: '720px', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, margin: '0 auto' }}>
          <button onClick={onRefresh} title="Refresh" style={{ width: 36, height: 36, borderRadius: 10, border: '1px solid var(--line)', background: '#fff', color: 'var(--ink-soft)', cursor: 'pointer' }}>
            <RefreshCw size={16} style={{ animation: refreshing ? 'ki-spin 0.8s linear infinite' : 'none' }} />
          </button>

          {authUser ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#fff', padding: '4px 12px 4px 4px', borderRadius: '20px', border: '1px solid var(--line)' }}>
              <img src={authUser.photoURL || `https://ui-avatars.com/api/?name=${authUser.displayName || 'User'}&background=EFF6FF&color=3B82F6`} alt="Profile" style={{ width: 28, height: 28, borderRadius: '50%' }} />
              <div style={{ display: 'flex', flexDirection: 'column', textAlign: 'left' }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink)' }}>{authUser.displayName}</span>
                <button onClick={onSignOut} style={{ all: 'unset', fontSize: 10, color: 'var(--owe)', cursor: 'pointer', fontWeight: 600 }}>Sign Out</button>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Not signed in</div>
          )}
        </div>

        {/* Title Section - Now Centered */}
        <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 32, color: 'var(--ink)', letterSpacing: '-0.02em', lineHeight: 1 }}>
          Kautim<span style={{ color: 'var(--stamp)' }}>.</span>
        </div>
        <div style={{ fontSize: 13, color: 'var(--ink-soft)', marginTop: 8 }}>
          split the bill, settle the tab, skip the awkward maths
        </div>
      </div>

      {/* Tabs - Centered */}
      <nav style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
        {TABS.map(t => {
          const active = view === t.id;
          return (
            <button key={t.id} onClick={() => setView(t.id)} className="ki-tab" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px', background: active ? 'var(--ink)' : '#fff', border: active ? '1px solid var(--ink)' : '1px solid var(--line)', borderRadius: '10px', cursor: 'pointer', transition: 'all 0.2s', boxShadow: active ? '0 4px 6px -1px rgba(0,0,0,0.1)' : '0 1px 2px rgba(0,0,0,0.05)' }}>
              <t.icon size={16} style={{ color: active ? '#fff' : 'var(--ink-soft)' }} />
              <span style={{ fontWeight: 600, fontSize: 14, color: active ? '#fff' : 'var(--ink)' }}>{t.label}</span>
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, letterSpacing: '0.03em', color: active ? 'rgba(255,255,255,0.5)' : 'var(--line)' }}>{t.code}</span>
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
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editQrCode, setEditQrCode] = useState('');
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
    mutate({ ...data, roster: [...data.roster, { id: uid(), name: trimmed, qrCode: '' }] });
    setName(''); setError('');
  }

  function removePerson(id) {
    if (referencedIds.has(id)) return;
    mutate({ ...data, roster: data.roster.filter(r => r.id !== id) });
    if (myId === id) setMyId(null);
  }

  function startEdit(p) {
    setEditingId(p.id); setEditName(p.name); setEditQrCode(p.qrCode || '');
  }

  function saveEdit() {
    const trimmed = editName.trim();
    if (!trimmed) return;
    mutate({
      ...data, roster: data.roster.map(r => r.id === editingId ? { ...r, name: trimmed, qrCode: editQrCode } : r),
    });
    setEditingId(null);
  }

  function handleQrUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => setEditQrCode(reader.result);
    reader.readAsDataURL(file);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="ki-card">
        <div className="ki-card-title">Add someone</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'end' }}>
          <div style={{ flex: 1 }}>
            <Field label="Name">
              <TextInput value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && addPerson()} placeholder="e.g. Darnish" />
            </Field>
          </div>
          <PrimaryButton onClick={addPerson} icon={UserPlus} disabled={!name.trim()}>Add</PrimaryButton>
        </div>
        {error && <div style={{ color: 'var(--owe)', fontSize: 13, marginTop: 10, fontWeight: 500 }}>{error}</div>}
      </div>

      <div className="ki-card">
        <div className="ki-card-title">Who's checking this?</div>
        <div style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginBottom: 12, lineHeight: 1.5 }}>
          Pick your name so the app knows who you are. This is saved just for you.
        </div>
        <select value={myId || ''} onChange={e => setMyId(e.target.value || null)} style={{ ...inputStyle, maxWidth: 300 }}>
          <option value="">— Select your name —</option>
          {data.roster.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>

      <div>
        <div className="ki-section-title">Roster ({data.roster.length})</div>
        {data.roster.length === 0 ? (
          <EmptyState icon={Users} title="Nobody added yet" body="Add everyone in the group above. Once they're on the roster, you can put them on bills." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {data.roster.map(p => (
              <div key={p.id} className="ki-card" style={{ padding: '16px' }}>
                {editingId === p.id ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <TextInput value={editName} onChange={e => setEditName(e.target.value)} autoFocus style={{ flex: 1 }} />
                      <GhostButton onClick={saveEdit}>Save</GhostButton>
                      <IconButton icon={X} label="Cancel" onClick={() => setEditingId(null)} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '13px', color: 'var(--ink-soft)', background: 'var(--paper-dim)', padding: '12px', borderRadius: '8px' }}>
                      <strong>Payment QR:</strong>
                      <input type="file" accept="image/*" onChange={handleQrUpload} style={{ fontSize: '12px' }} />
                      {editQrCode && <span style={{ color: 'var(--settled)', fontWeight: 'bold' }}>✓ Uploaded</span>}
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                      <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--stamp-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 14, color: 'var(--stamp)', fontFamily: "'Space Grotesk', sans-serif" }}>{p.name.slice(0, 1).toUpperCase()}</div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 8, fontFamily: "'Space Grotesk', sans-serif" }}>
                          {p.name}
                          {myId === p.id && <span style={{ fontSize: 10, color: 'var(--stamp)', background: 'var(--stamp-bg)', padding: '2px 7px', borderRadius: '5px', fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace", letterSpacing: '0.04em' }}>YOU</span>}
                          {p.qrCode && <QrCode size={14} color="var(--stamp)" title="Has QR Code" />}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
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
  const [scanMessage, setScanMessage] = useState('');
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
    const file = e.target.files?.[0];
    if (!file) return;

    setIsScanning(true);
    setScanMessage('');

    try {
      const { data: { text } } = await Tesseract.recognize(file, 'eng');
      const lines = (text || '')
        .replace(/\r/g, '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

      const scannedItems = [];
      const ignoredKeywords = ['total', 'subtotal', 'tax', 'service', 'cash', 'change', 'payment', 'thank', 'visa', 'mastercard', 'card', 'gst', 'sst', 'receipt', 'balance'];

      lines.forEach(line => {
        const normalized = line.toLowerCase();
        if (ignoredKeywords.some(keyword => normalized.includes(keyword))) return;
        if (line.length < 3) return;

        const match = line.match(/(.+?)\s+([0-9]+(?:[.,][0-9]{1,2}))\s*(?:rm|myr)?$/i);
        if (!match) return;

        const rawName = match[1].trim().replace(/^(rm|myr)\s*/i, '').trim();
        const rawPrice = match[2].replace(/,/g, '.');
        const price = Number(rawPrice);

        if (!rawName || !Number.isFinite(price) || price <= 0) return;

        scannedItems.push({
          id: uid(),
          name: rawName.replace(/[^a-zA-Z0-9 &/-]/g, '').trim(),
          unitPrice: String(price.toFixed(2)),
          quantity: 1,
          assignments: []
        });
      });

      if (scannedItems.length > 0) {
        setDraft(d => ({ ...d, items: [...d.items, ...scannedItems] }));
        setScanMessage(`Added ${scannedItems.length} item${scannedItems.length > 1 ? 's' : ''} from the receipt.`);
      } else {
        setScanMessage('We could not detect clear item lines from that receipt. Try a brighter, straight-on photo or enter items manually.');
      }
    } catch (err) {
      console.error('OCR Error:', err);
      setScanMessage('The receipt scan failed. Please try another photo or enter items manually.');
    } finally {
      setIsScanning(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
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
          <input type="file" accept="image/png,image/jpeg,image/jpg,image/webp" capture="environment" ref={fileInputRef} onChange={handleScanReceipt} style={{ display: 'none' }} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {draft.items.map((it, idx) => {
            const lineTotal = round2((Number(it.unitPrice) || 0) * (Number(it.quantity) || 1));
            const allocated = round2((it.assignments || []).reduce((s, a) => s + (a.amount || 0), 0));
            const diff = round2(lineTotal - allocated);
            return (
              <div key={it.id} className="receipt-line" style={{ paddingTop: idx === 0 ? 0 : 14 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '22px 1fr 90px 64px 30px', gap: 8, alignItems: 'end', marginBottom: 9 }}>
                  <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: 'var(--ink-soft)', paddingBottom: 9, textAlign: 'right' }}>
                    {String(idx + 1).padStart(2, '0')}
                  </div>
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
                      <button key={p.id} onClick={() => toggleParticipant(it.id, p.id)} className="ki-chip" style={{ padding: '5px 11px', borderRadius: 999, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s', border: on ? '1.5px solid var(--stamp)' : '1.5px solid var(--line)', background: on ? 'var(--stamp)' : '#fff', color: on ? '#fff' : 'var(--ink-soft)' }}>
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

        {scanMessage && (
          <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--ink-soft)', background: 'var(--paper-dim)', padding: '8px 10px', borderRadius: 8, lineHeight: 1.5 }}>
            {scanMessage}
          </div>
        )}

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
                <span style={{ fontWeight: 600, color: 'var(--ink)', fontFamily: "'Space Grotesk', sans-serif" }}>
                  {personName(data.roster, pid)}{pid === draft.payerId && <span style={{ color: 'var(--stamp)', background: 'var(--stamp-bg)', fontSize: 10, marginLeft: 6, fontWeight: 700, padding: '2px 7px', borderRadius: '5px', fontFamily: "'IBM Plex Mono', monospace", letterSpacing: '0.04em' }}>PAYER</span>}
                </span>
                <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600, color: 'var(--ink)' }}>{fmt(p.totalOwed)}</span>
              </div>
            ))}
            <div className="receipt-divider" />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 700, fontFamily: "'Space Grotesk', sans-serif" }}>
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

function BillRow({ bill, roster, onAddPayment, onDelete, onUpdateBill }) {
  const [open, setOpen] = useState(false);
  const [pendingEdits, setPendingEdits] = useState({}); // { [paymentId]: editedAmountString }
  const summary = useMemo(() => computeBill(bill), [bill]);
  const settled = isBillSettled(bill);
  function getEditedAmount(pm) {
    return pendingEdits[pm.id] !== undefined ? pendingEdits[pm.id] : String(pm.amount);
  }

  function approvePending(pm) {
    const finalAmount = round2(Number(getEditedAmount(pm)) || 0);
    onUpdateBill({
      ...bill,
      payments: bill.payments.map(p => p.id === pm.id ? { ...p, amount: finalAmount, status: 'approved' } : p)
    });
    setPendingEdits(edits => { const next = { ...edits }; delete next[pm.id]; return next; });
  }

  function rejectPending(pm) {
    onUpdateBill({
      ...bill,
      payments: bill.payments.filter(p => p.id !== pm.id)
    });
    setPendingEdits(edits => { const next = { ...edits }; delete next[pm.id]; return next; });
  }

  function copyShareLink() {
    const url = `${window.location.origin}${window.location.pathname}?share=${auth.currentUser.uid}&bill=${bill.id}`;
    navigator.clipboard.writeText(url);
    alert("Share link copied to clipboard!");
  }

  return (
    <div className="ki-card receipt-card">
      <button onClick={() => setOpen(o => !o)} style={{ all: 'unset', display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', cursor: 'pointer', boxSizing: 'border-box' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14.5, color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontFamily: "'Space Grotesk', sans-serif" }}>
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

          {bill.payments?.filter(pm => pm.status === 'pending').map(pm => (
            <div key={pm.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: 'var(--pending-bg)', border: '1.5px dashed var(--pending)', borderRadius: 8, marginBottom: 8, gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, marginBottom: 6, color: 'var(--ink)' }}>
                  <strong style={{ color: 'var(--pending)' }}>{personName(roster, pm.personId)}</strong> marked a payment as paid
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 11, color: 'var(--ink-soft)' }}>Confirm amount RM</span>
                  <input
                    type="number"
                    step="0.01"
                    value={getEditedAmount(pm)}
                    onChange={e => setPendingEdits(edits => ({ ...edits, [pm.id]: e.target.value }))}
                    style={{
                      width: 78,
                      padding: '4px 7px',
                      borderRadius: 6,
                      border: '1.5px solid var(--line)',
                      fontFamily: "'IBM Plex Mono', monospace",
                      fontSize: 12.5,
                      textAlign: 'right',
                      background: '#fff',
                      color: 'var(--ink)',        // ← add this
                      colorScheme: 'light'        // ← add this, stops browser dark-mode from re-tinting it
                    }}
                  />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button onClick={() => approvePending(pm)} style={{ fontSize: 11, padding: '5px 9px', borderRadius: 6, background: 'var(--settled)', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600 }}>
                  Approve
                </button>
                <button onClick={() => rejectPending(pm)} style={{ fontSize: 11, padding: '5px 9px', borderRadius: 6, background: 'var(--owe)', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600 }}>
                  Reject
                </button>
              </div>
            </div>
          ))}
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
            {Object.entries(summary.perPerson).map(([pid, p]) => {
              const isSettled = p.remaining <= 0.004 && p.remaining >= -0.004;
              const isDeficit = p.remaining < -0.004;

              return (
                <div key={pid} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', borderRadius: 9, background: 'var(--paper-dim)', fontSize: 13 }}>
                  <div>
                    <div style={{ fontWeight: 600, color: 'var(--ink)' }}>
                      {personName(roster, pid)} {pid === bill.payerId && <span style={{ fontSize: 10, color: 'var(--stamp)', background: 'var(--stamp-bg)', padding: '2px 7px', borderRadius: '5px', fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace", letterSpacing: '0.04em', marginLeft: 4 }}>PAYER</span>}
                    </div>
                    {pid !== bill.payerId && (
                      <div style={{ fontSize: 11, color: 'var(--ink-soft)', fontFamily: "'IBM Plex Mono', monospace", marginTop: 4 }}>
                        <div>food {fmt(p.subtotal)} + tax {fmt(p.tax)} + svc {fmt(p.service)}</div>
                        <div style={{ marginTop: 4, fontWeight: 600, color: 'var(--ink)' }}>
                          Total: {fmt(p.totalOwed)} · Paid: {fmt(p.paid)}
                        </div>
                      </div>
                    )}
                  </div>
                  {pid !== bill.payerId && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, color: isDeficit ? 'var(--stamp)' : isSettled ? 'var(--settled)' : 'var(--owe)' }}>
                        {isDeficit ? `DEFICIT ${fmt(Math.abs(p.remaining))}` : isSettled ? 'Paid' : fmt(p.remaining)}
                      </span>
                      {isDeficit && (
                        <button
                          onClick={() => onAddPayment(bill.id, { id: uid(), personId: pid, amount: round2(p.remaining), method: 'Refund', note: 'Deficit returned manually', date: todayISO() })}
                          style={{ padding: '6px 10px', fontSize: 11, borderRadius: 6, background: 'var(--stamp)', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600 }}>
                          Refund
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {!settled && (
            <div style={{ marginBottom: 14 }}>
              <div className="ki-section-title" style={{ marginBottom: 7 }}>
                Log a payment
              </div>
              <PaymentForm roster={roster} bill={bill} onAdd={(p) => onAddPayment(bill.id, p)} />
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <GhostButton icon={Copy} onClick={copyShareLink} style={{ flex: 1, justifyContent: 'center' }}>Copy Share Link</GhostButton>
            <GhostButton icon={Trash2} onClick={() => onDelete(bill.id)} style={{ flex: 1, justifyContent: 'center', color: 'var(--owe)', background: 'var(--owe-bg)', border: 'none' }}>Delete Bill</GhostButton>
          </div>
        </div>
      )}
    </div>
  );
}

function QRCodeModal({ payer, amount, onClose }) {
  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }} onClick={onClose}>
      <div className="ki-card" style={{ padding: 24, textAlign: 'center', width: 280 }} onClick={e => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8, fontFamily: "'Space Grotesk', sans-serif", color: 'var(--ink)' }}>Pay {payer.name}</div>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 24, color: 'var(--stamp)', fontWeight: 700, marginBottom: 16 }}>{fmt(amount)}</div>

        <div style={{ background: '#fff', padding: 12, border: '1px solid var(--line)', borderRadius: 12, display: 'inline-block', marginBottom: 16 }}>
          {payer.qrCode ? (
            <img src={payer.qrCode} alt={`${payer.name}'s QR Code`} style={{ display: 'block', width: 200, height: 200, objectFit: 'contain' }} />
          ) : (
            <div style={{ width: 200, height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--paper-dim)', color: 'var(--ink-soft)', fontSize: 13, padding: 20 }}>
              No QR code uploaded.<br /><br />Edit {payer.name} in the People tab to add one!
            </div>
          )}
        </div>

        <GhostButton onClick={onClose} style={{ width: '100%', justifyContent: 'center' }}>Close</GhostButton>
      </div>
    </div>
  );
}

function LedgerView({ data, mutate, roster }) {
  const ledger = useMemo(() => computeLedger(data), [data]);
  const [activeQR, setActiveQR] = useState(null);

  function addPayment(billId, payment) {
    mutate({ ...data, bills: data.bills.map(b => b.id === billId ? { ...b, payments: [...(b.payments || []), payment] } : b) });
  }
  function updateBill(updatedBill) {
    mutate({ ...data, bills: data.bills.map(b => b.id === updatedBill.id ? updatedBill : b) });
  }

  function deleteBill(billId) {
    mutate({ ...data, bills: data.bills.filter(b => b.id !== billId) });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {activeQR && <QRCodeModal payer={activeQR.payer} amount={activeQR.amount} onClose={() => setActiveQR(null)} />}

      <div>
        <div className="ki-section-title">Who owes who</div>
        {ledger.length === 0 ? (
          <EmptyState icon={Wallet} title="All settled up" body="No outstanding balances right now. Once you save a bill, anything owed will show up here." />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
            {ledger.map(p => {
              const payerObj = roster.find(r => r.id === p.payerId);
              const payerName = payerObj ? payerObj.name : 'Unknown';
              return (
                <div key={`${p.debtorId}__${p.payerId}`} className="ki-card" style={{ padding: '13px 15px', borderLeft: '3px solid var(--owe)' }}>
                  <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', display: 'flex', alignItems: 'center', gap: 5 }}>
                    <strong style={{ color: 'var(--ink)', fontFamily: "'Space Grotesk', sans-serif" }}>{personName(roster, p.debtorId)}</strong>
                    <ArrowRight size={12} style={{ color: 'var(--ink-soft)', flexShrink: 0 }} />
                    <strong style={{ color: 'var(--ink)', fontFamily: "'Space Grotesk', sans-serif" }}>{payerName}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 6 }}>
                    <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, fontSize: 19, color: 'var(--owe)' }}>
                      {fmt(p.amount)}
                    </div>
                    <IconButton icon={QrCode} label="Show QR to Pay" onClick={() => setActiveQR({ payer: payerObj, amount: p.amount })} />
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
              <BillRow key={bill.id} bill={bill} roster={roster}
                onAddPayment={addPayment} onDelete={deleteBill} onUpdateBill={updateBill} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- App shell ----------------------------- */
function SharedBillView({ shareUserId, shareBillId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeQR, setActiveQR] = useState(null);
  const [processingPersonId, setProcessingPersonId] = useState(null);

  useEffect(() => {
    async function fetchShared() {
      try {
        const docSnap = await getDoc(doc(db, "users", shareUserId));
        if (docSnap.exists()) {
          setData(docSnap.data());
        }
      } catch (e) { console.error(e); }
      setLoading(false);
    }
    fetchShared();
  }, [shareUserId]);

  if (loading) return <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', background: '#F9FAFB' }}><Loader2 size={24} style={{ animation: 'ki-spin 0.8s linear infinite', color: '#3B82F6' }} /></div>;
  if (!data) return <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', background: '#F9FAFB', color: '#6B7280' }}>Bill not found.</div>;

  const bill = (data.bills || []).find(b => b.id === shareBillId);
  const roster = data.roster || [];
  if (!bill) return <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', background: '#F9FAFB', color: '#6B7280' }}>Bill has been deleted.</div>;

  const summary = computeBill(bill);
  const payer = roster.find(r => r.id === bill.payerId);

  async function markSelfPaid(personId, amount) {
    const alreadyPending = (bill.payments || []).some(pm => pm.personId === personId && pm.status === 'pending');
    if (processingPersonId || alreadyPending) return;

    setProcessingPersonId(personId);
    try {
      const docRef = doc(db, "users", shareUserId);
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        const currentData = docSnap.data();
        const updatedBills = currentData.bills.map(b => {
          if (b.id === shareBillId) {
            return {
              ...b,
              payments: [...(b.payments || []), {
                id: uid(),
                personId,
                amount,
                method: 'Shared Link',
                note: 'Self-Marked',
                date: todayISO(),
                status: 'pending'
              }]
            };
          }
          return b;
        });
        await setDoc(docRef, { ...currentData, bills: updatedBills });
        setData({ ...currentData, bills: updatedBills });
      }
    } catch (e) { alert("Failed to log payment."); }
    finally { setProcessingPersonId(null); }
  }

  return (
    <div style={{ background: 'linear-gradient(135deg, #F9FAFB 0%, #E5E7EB 100%)', minHeight: '100vh', padding: '40px 16px', display: 'block', width: '100%' }}>
      <style>{`
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Mono:wght@500;600;700&display=swap');
  :root {
    --paper: #FAFAF8; --paper-dim: #F1F0EC; --ink: #1A1A1A; --ink-soft: #6B6B63;
    --owe: #C0392B; --owe-bg: #FBEAE7; --settled: #1E7A4C; --settled-bg: #E3F3EA;
    --stamp: #2451B5; --stamp-bg: #EAF0FB; --pending: #A8720B; --pending-bg: #FBF1DD;
    --line: #E4E2DB;
  }
  html, body, #root { margin: 0; padding: 0; width: 100%; min-height: 100vh; font-family: 'Inter', sans-serif; display: block !important; }
  * { box-sizing: border-box; }
  @keyframes ki-spin { to { transform: rotate(360deg); } }
`}</style>

      {activeQR && <QRCodeModal payer={activeQR.payer} amount={activeQR.amount} onClose={() => setActiveQR(null)} />}

      <div style={{ maxWidth: '480px', margin: '0 auto', background: '#fff', borderRadius: '20px', overflow: 'hidden', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)' }}>
        {/* Header Section */}
        <div style={{ background: 'var(--ink)', padding: '32px 24px 40px', textAlign: 'center', color: '#fff', position: 'relative' }}>
          <div style={{ background: 'rgba(255,255,255,0.1)', display: 'inline-flex', padding: '6px 12px', borderRadius: '5px', fontSize: '12px', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: '16px', fontFamily: "'Space Grotesk', sans-serif" }}>
            Shared Bill
          </div>
          <h2 style={{ margin: '0 0 8px 0', fontSize: '28px', fontWeight: 700, letterSpacing: '-0.02em', fontFamily: "'Space Grotesk', sans-serif" }}>{bill.title}</h2>
          <div style={{ fontSize: '14px', color: '#B0AEA6', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontFamily: "'IBM Plex Mono', monospace" }}>
            <Receipt size={14} /> {niceDate(bill.date)}
          </div>
          {/* torn perforation edge */}
          <div style={{
            position: 'absolute', left: 0, right: 0, bottom: -1, height: 14,
            background: 'radial-gradient(circle at 10px 0, transparent 9px, #fff 9.5px)',
            backgroundSize: '20px 14px', backgroundRepeat: 'repeat-x'
          }} />
        </div>

        <div style={{ padding: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', paddingBottom: '16px', borderBottom: '1px dashed #E5E7EB' }}>
            <div style={{ fontSize: '13px', color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>Paid By</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: '#EFF6FF', color: '#3B82F6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '12px' }}>
                {payer?.name.charAt(0).toUpperCase()}
              </div>
              <strong style={{ color: '#111827', fontSize: '15px' }}>{payer?.name}</strong>
            </div>
          </div>

          <div style={{ fontWeight: 600, marginBottom: '16px', color: '#111827', fontSize: '15px' }}>Breakdown</div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {Object.entries(summary.perPerson).map(([pid, p]) => {
              if (pid === bill.payerId) return null;
              const person = roster.find(r => r.id === pid);
              const hasPending = (bill.payments || []).some(pm => pm.personId === pid && pm.status === 'pending');
              const isDeficit = !hasPending && (p.remaining < -0.004);
              const isSettled = !hasPending && (p.remaining <= 0.004 && p.remaining >= -0.004);

              const userItems = bill.items.filter(it => it.assignments.some(a => a.personId === pid && a.amount > 0));

              return (
                <div key={pid} style={{ border: '1px solid #E5E7EB', borderRadius: '12px', overflow: 'hidden' }}>
                  {/* Top Bar */}
                  <div style={{ background: '#F9FAFB', padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '1px solid #E5E7EB' }}>
                    <div>
                      <div style={{ fontWeight: 600, color: '#111827', fontSize: '15px' }}>{person?.name}</div>
                      <div style={{ fontSize: '12px', color: '#6B7280', marginTop: '4px' }}>
                        Total: <strong>{fmt(p.totalOwed)}</strong> • Paid: <strong>{fmt(p.paid)}</strong>
                      </div>
                    </div>
                    <div style={{ fontWeight: 700, fontSize: '13px', color: hasPending ? '#F59E0B' : isDeficit ? '#3B82F6' : isSettled ? '#10B981' : '#EF4444', background: hasPending ? '#FEF3C7' : isDeficit ? '#EFF6FF' : isSettled ? '#D1FAE5' : '#FEE2E2', padding: '6px 10px', borderRadius: '6px' }}>
                      {hasPending ? 'Pending Verification ⏳' : isDeficit ? `DEFICIT: ${fmt(Math.abs(p.remaining))}` : isSettled ? 'Paid ✓' : `Owes: ${fmt(p.remaining)}`}
                    </div>
                  </div>

                  {/* Items & Actions Bar */}
                  <div style={{ padding: '16px', background: '#fff' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
                      {userItems.map(it => {
                        const assignment = it.assignments.find(a => a.personId === pid);
                        return (
                          <div key={it.id} style={{ display: 'flex', justifyContent: 'space-between', color: '#4B5563', fontSize: '13px' }}>
                            <span>{it.name}</span>
                            <span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmt(assignment.amount)}</span>
                          </div>
                        );
                      })}
                      <div style={{ display: 'flex', justifyContent: 'space-between', color: '#9CA3AF', borderTop: '1px dashed #E5E7EB', marginTop: '8px', paddingTop: '12px', fontSize: '13px' }}>
                        <span>Tax & Service</span>
                        <span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmt(p.tax + p.service)}</span>
                      </div>
                    </div>

                    {!isSettled && !isDeficit && (
                      <div style={{ display: 'flex', gap: '8px', paddingTop: '16px', borderTop: '1px solid #F3F4F6' }}>
                        <button onClick={() => setActiveQR({ payer, amount: p.remaining })} style={{ flex: 1, padding: '10px', fontSize: '13px', borderRadius: '8px', background: '#EFF6FF', color: '#3B82F6', border: 'none', cursor: 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                          <QrCode size={14} /> Pay QR
                        </button>
                        <button onClick={() => markSelfPaid(pid, p.remaining)} disabled={processingPersonId === pid || hasPending} style={{ flex: 1, padding: '10px', fontSize: '13px', borderRadius: '8px', background: '#111827', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', opacity: processingPersonId === pid || hasPending ? 0.7 : 1 }}>
                          {processingPersonId === pid ? <Loader2 size={14} style={{ animation: 'ki-spin 0.8s linear infinite' }} /> : <Check size={14} />} {hasPending ? 'Pending Verification' : processingPersonId === pid ? 'Submitting…' : 'Mark Paid'}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {

  const urlParams = new URLSearchParams(window.location.search);
  const shareUserId = urlParams.get('share');
  const shareBillId = urlParams.get('bill');
  const [authUser, setAuthUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true); // Checks session before rendering
  const [data, setData] = useState(emptyData());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [myId, setMyIdState] = useState(null);
  const [view, setView] = useState('ledger');
  function goToLedger() { setView('ledger'); }

  // Firebase listener to persist login across refreshes
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setAuthUser(user);
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("Login failed", error);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
      setData(emptyData()); // Clear local data on sign out
    } catch (error) {
      console.error("Sign out failed", error);
    }
  };

  const refresh = useCallback(async () => {
    if (!authUser) return;
    setRefreshing(true);
    const d = await loadData(authUser.uid);
    setData(d);
    setRefreshing(false);
  }, [authUser]);

  useEffect(() => {
    if (!authUser) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      const d = await loadData(authUser.uid);
      const localId = localStorage.getItem('kautim-identity');
      if (!cancelled) {
        setData(d);
        setMyIdState(localId ? JSON.parse(localId).personId : null);
        setLoading(false);
      }
    })();
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; window.removeEventListener('focus', onFocus); };
  }, [authUser, refresh]);

  const mutate = useCallback((next) => {
    setData(next);
    if (authUser) persistData(authUser.uid, next);
  }, [authUser]);

  const setMyId = useCallback((id) => {
    setMyIdState(id);
    localStorage.setItem('kautim-identity', JSON.stringify({ personId: id }));
  }, []);
  // NOW branch — no hooks below this point
  if (shareUserId && shareBillId) {
    return <SharedBillView shareUserId={shareUserId} shareBillId={shareBillId} />;
  }

  // Show a loading spinner while Firebase checks if you are logged in
  if (authLoading) {
    return <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', background: '#F9FAFB' }}><Loader2 size={24} style={{ animation: 'ki-spin 0.8s linear infinite', color: '#3B82F6' }} /></div>;
  }
  // Clean, Modern Login Screen
  if (!authUser) {
    return (
      <div style={{ display: 'flex', width: '100%', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, #F9FAFB 0%, #E5E7EB 100%)', margin: 0, padding: 20 }}>
        <style>{`
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&display=swap');
  :root {
    --paper: #FAFAF8; --paper-dim: #F1F0EC; --ink: #1A1A1A; --ink-soft: #6B6B63;
    --stamp: #2451B5; --stamp-bg: #EAF0FB; --line: #E4E2DB;
  }
  /* Forces the background to cover the entire screen and overrides Vite's default flexbox */
  html, body, #root { margin: 0; padding: 0; width: 100%; min-height: 100vh; font-family: 'Inter', sans-serif; display: block !important; }
  * { box-sizing: border-box; }
`}</style>

        <div style={{ background: '#fff', border: '1px solid var(--line)', borderRadius: '24px', padding: '48px 40px', textAlign: 'center', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.05), 0 8px 10px -6px rgba(0, 0, 0, 0.01)', maxWidth: '400px', width: '100%', position: 'relative', overflow: 'hidden', margin: '0 auto' }}>

          {/* Decorative background blur */}
          <div style={{ position: 'absolute', top: -50, left: -50, width: 150, height: 150, background: 'var(--stamp-bg)', borderRadius: '50%', zIndex: 0, filter: 'blur(40px)' }}></div>

          <div style={{ position: 'relative', zIndex: 1 }}>

            {/* App Icon */}
            <div style={{ background: 'var(--paper-dim)', width: 64, height: 64, borderRadius: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 24px auto', border: '1px solid var(--line)' }}>
              <Wallet size={32} color="var(--stamp)" strokeWidth={1.5} />
            </div>

            <h2 style={{ margin: '0 0 8px 0', color: 'var(--ink)', fontSize: '32px', fontWeight: 700, letterSpacing: '-0.02em', fontFamily: "'Space Grotesk', sans-serif" }}>
              Kautim<span style={{ color: 'var(--stamp)' }}>.</span>
            </h2>

            <p style={{ margin: '0 0 32px 0', color: 'var(--ink-soft)', fontSize: '14px', lineHeight: 1.5 }}>
              Split the bill, settle the tab, and skip the awkward group chat maths.
            </p>

            <button
              onClick={handleLogin}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', width: '100%', padding: '14px 24px', borderRadius: '12px', cursor: 'pointer', background: 'var(--ink)', color: '#fff', border: 'none', fontWeight: '600', fontSize: '15px', transition: 'all 0.2s', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1)' }}
              onMouseOver={e => e.currentTarget.style.transform = 'translateY(-1px)'}
              onMouseOut={e => e.currentTarget.style.transform = 'translateY(0)'}
            >
              {/* Google G Logo SVG */}
              <svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              </svg>
              Continue with Google
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Clean, Modern Main App
  return (
    <div style={{ background: 'var(--paper)', width: '100%', minHeight: '100vh', padding: '20px 16px 60px' }}>
      <style>{`
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Mono:wght@500;600;700&display=swap');
  
:root {
  --paper: #FAFAF8; --paper-dim: #F1F0EC; --ink: #1A1A1A; --ink-soft: #6B6B63;
  --owe: #C0392B; --owe-bg: #FBEAE7; --settled: #1E7A4C; --settled-bg: #E3F3EA;
  --stamp: #2451B5; --stamp-bg: #EAF0FB; --pending: #A8720B; --pending-bg: #FBF1DD;
  --line: #E4E2DB;
}
  
  html, body, #root { margin: 0; padding: 0; width: 100%; min-height: 100vh; background-color: var(--paper); display: block !important; }
  * { box-sizing: border-box; font-family: 'Inter', sans-serif; }
        
        .ki-card { background: #fff; border: 1px solid var(--line); border-radius: 16px; padding: 24px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05), 0 2px 4px -1px rgba(0,0,0,0.03); }
        .ki-card-title { font-weight: 700; font-size: 17px; color: var(--ink); margin-bottom: 18px; }
        .ki-section-title { font-weight: 700; font-size: 12px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 16px; }
        
        .ki-input:focus, select:focus, textarea:focus { border-color: var(--stamp) !important; outline: none; box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15); }
        button:focus-visible { outline: 2px solid var(--stamp); outline-offset: 2px; }
        
        nav::-webkit-scrollbar { display: none; }
        nav { -ms-overflow-style: none; scrollbar-width: none; }
        
        .dot-leader { flex: 1; border-bottom: 1px dashed #D1D5DB; margin-bottom: 4px; min-width: 16px; }
        .receipt-divider { border-top: 1px solid var(--line); margin: 20px 0; }
        .receipt-line + .receipt-line { border-top: 1px solid var(--line); margin-top: 16px; }
        
        .stamp-badge { transform: rotate(0deg); border: 1px solid !important; border-radius: 6px !important; }
        ::placeholder { color: #9CA3AF; }
        select, textarea, .ki-input { width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--line); background: #fff; color: var(--ink); font-size: 14.5px; transition: all 0.2s; }
        
        @keyframes ki-spin { to { transform: rotate(360deg); } }
      `}</style>

      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <Header view={view} setView={setView} onRefresh={refresh} refreshing={refreshing} authUser={authUser} onSignOut={handleSignOut} />


        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, color: 'var(--ink-soft)', fontSize: 14, padding: '40px 0', justifyContent: 'center' }}>
            Loading the tab...
          </div>
        ) : (
          <>
            {view === 'ledger' && <LedgerView data={data} mutate={mutate} roster={data.roster} />}
            {view === 'newbill' && <NewBillView data={data} mutate={mutate} myId={myId} goToLedger={goToLedger} />}
            {view === 'people' && <PeopleView data={data} mutate={mutate} myId={myId} setMyId={setMyId} />}
          </>
        )}
      </div>
    </div>
  );
}