import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoiceTotal, lineTotal, type DraftLine, type PaymentMode, type SavedInvoice } from '@dukaansetu/shared';
import { createInvoice, localDb, pendingBillCount, syncOnce } from './localDb';

const emptyLine = (): DraftLine => ({name:'',quantity:1,unitPrice:0,gstRate:0});
const money = (n:number) => new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format(n);
const storedPrefix = () => { let value=localStorage.getItem('invoice_prefix'); if (!value) { value=`D${crypto.randomUUID().slice(0,5).toUpperCase()}`; localStorage.setItem('invoice_prefix',value); } return value; };

export function App() {
  const [party,setParty]=useState(''), [phone,setPhone]=useState(''), [paid,setPaid]=useState('0');
  const [mode,setMode]=useState<PaymentMode>('CASH'), [lines,setLines]=useState<DraftLine[]>([emptyLine()]);
  const [online,setOnline]=useState(navigator.onLine), [pending,setPending]=useState(0), [message,setMessage]=useState('');
  const [apiUrl,setApiUrl]=useState(localStorage.getItem('api_base_url') || ''), [token,setToken]=useState(localStorage.getItem('sync_token') || '');
  const total=useMemo(()=>invoiceTotal(lines),[lines]);
  const refresh=useCallback(async()=>setPending(await pendingBillCount()),[]);
  const sync=useCallback(async()=>{
    if (!navigator.onLine || !apiUrl || !token) return;
    try { await syncOnce(apiUrl,token); setMessage('Sync complete'); }
    catch { setMessage('Saved locally • Sync will retry when connected'); }
    await refresh();
  },[apiUrl,token,refresh]);
  useEffect(()=>{ const on=()=>setOnline(true), off=()=>setOnline(false); window.addEventListener('online',on); window.addEventListener('offline',off); void refresh();
    const timer=window.setInterval(()=>{ void refresh(); if(navigator.onLine) void sync(); },30000); return()=>{window.removeEventListener('online',on);window.removeEventListener('offline',off);window.clearInterval(timer);}; },[refresh,sync]);

  const save=useCallback(async()=>{
    try {
      const invoice=await createInvoice({partyName:party,phone,paid:Number(paid)||0,paymentMode:mode,lines},storedPrefix());
      setMessage(`Bill ${invoice.number} saved on this device`); await refresh();
      makePdf(invoice,party,lines);
      if(navigator.onLine) void sync();
    } catch(e) { setMessage(e instanceof Error ? e.message : 'Could not save bill'); }
  },[party,phone,paid,mode,lines,refresh,sync]);
  useEffect(()=>{const onKey=(e:KeyboardEvent)=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();void save();}};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);},[save]);

  const updateLine=(index:number,key:keyof DraftLine,value:string)=>setLines(current=>current.map((line,i)=>i===index?{...line,[key]:key==='name'?value:Number(value)||0}:line));
  const saveConfig=()=>{localStorage.setItem('api_base_url',apiUrl);localStorage.setItem('sync_token',token);setMessage('Sync settings saved');if(online)void sync();};
  return <main className="shell">
    <header className="topbar"><div className="brand"><span className="mark">દ</span><div><b>DukaanSetu</b><small>Billing • Hisab • Dukaan</small></div></div>
      <div className={`sync-pill ${online?'online':'offline'}`}><i/>{online?(pending?`Online • ${pending} bills syncing`:'Online • Everything synced'):`Offline • ${pending} bills saved locally`}</div>
    </header>
    <div className="layout"><section className="billing panel">
      <div className="section-head"><div><div className="eyebrow">POINT OF SALE</div><h1>Naya Bill</h1></div><span className="shortcut">Ctrl + Enter to save</span></div>
      <div className="party-grid"><label>Customer / Grahak<input value={party} onChange={e=>setParty(e.target.value)} placeholder="Customer name" autoFocus /></label>
        <label>WhatsApp number<input value={phone} onChange={e=>setPhone(e.target.value)} inputMode="tel" placeholder="+91" /></label></div>
      <div className="items-heading"><span>ITEM DETAILS</span><span>Amount</span></div>
      <div className="lines">{lines.map((line,i)=><div className="line" key={i}>
        <input className="item-name" value={line.name} onChange={e=>updateLine(i,'name',e.target.value)} placeholder={`Item ${i+1} / Samaan`} />
        <input aria-label="Quantity" type="number" min="0.001" step="any" value={line.quantity} onChange={e=>updateLine(i,'quantity',e.target.value)} />
        <input aria-label="Rate" type="number" min="0" step="0.01" value={line.unitPrice||''} onChange={e=>updateLine(i,'unitPrice',e.target.value)} placeholder="Rate ₹" />
        <input aria-label="GST rate" type="number" min="0" step="0.1" value={line.gstRate||''} onChange={e=>updateLine(i,'gstRate',e.target.value)} placeholder="GST %" />
        <b>{money(lineTotal(line))}</b>
        <button className="icon-button" aria-label="Remove item" onClick={()=>setLines(v=>v.length===1?v:[...v.filter((_,n)=>n!==i)])}>×</button>
      </div>)}</div>
      <button className="add-line" onClick={()=>setLines(v=>[...v,emptyLine()])}>＋ Add item</button>
      <div className="settlement"><label>Payment mode<select value={mode} onChange={e=>setMode(e.target.value as PaymentMode)}><option value="CASH">Cash / Nagad</option><option value="UPI">UPI</option><option value="UDHAAR">Udhaar / Credit</option></select></label>
        <label>Paid now<input type="number" min="0" step="0.01" value={paid} onChange={e=>setPaid(e.target.value)} /></label>
      </div>
      <div className="totals"><div><span>Total</span><strong>{money(total)}</strong></div><div><span>Balance / Udhaar</span><strong className="due">{money(Math.max(0,total-(Number(paid)||0)))}</strong></div></div>
      <button className="save-button" onClick={()=>void save()}>Save bill &amp; generate PDF <span>↗</span></button>
      <p className="feedback" role="status">{message || 'Bill is saved on this device first. Sync runs in the background.'}</p>
    </section>
    <aside className="side-column"><section className="panel info-card"><div className="eyebrow">WORKS WITHOUT INTERNET</div><h2>Your counter keeps moving.</h2><p>Bills are stored on this device right away. They sync to your shop when internet returns.</p><div className="stat"><span>Unsent bills</span><b>{pending}</b></div></section>
      <details className="panel settings"><summary>Sync connection settings</summary><label>API server URL<input value={apiUrl} onChange={e=>setApiUrl(e.target.value)} placeholder="https://api.yourdukaan.in" /></label><label>Device sync token<input type="password" value={token} onChange={e=>setToken(e.target.value)} placeholder="Provided by your shop admin" /></label><button onClick={saveConfig}>Save connection</button></details>
      <div className="trust-note">🔒 Local-first billing <span>•</span> Built for Indian dukaan</div>
    </aside></div>
  </main>;
}

function makePdf(invoice:SavedInvoice,party:string,lines:DraftLine[]) {
  void buildPdf(invoice,party,lines);
}

async function buildPdf(invoice:SavedInvoice,party:string,lines:DraftLine[]) {
  const {jsPDF}=await import('jspdf');
  const pdf=new jsPDF(); pdf.setFontSize(20); pdf.text('DukaanSetu • Invoice',16,20);pdf.setFontSize(11);pdf.text(`Invoice: ${invoice.number}`,16,32);pdf.text(`Customer: ${party}`,16,40);pdf.text(`Date: ${new Date(invoice.createdAt).toLocaleDateString('en-IN')}`,16,48);
  let y=64;pdf.setFont('helvetica','bold');pdf.text('Item',16,y);pdf.text('Qty',100,y);pdf.text('Rate',127,y);pdf.text('Amount',165,y);pdf.setFont('helvetica','normal');y+=8;
  for(const l of lines){pdf.text(l.name.slice(0,42),16,y);pdf.text(String(l.quantity),100,y);pdf.text(money(l.unitPrice),127,y);pdf.text(money(lineTotal(l)),165,y);y+=8;}
  y+=8;pdf.text(`Total: ${money(invoice.total)}`,145,y);y+=8;pdf.text(`Paid: ${money(invoice.paid)}`,145,y);y+=8;pdf.setFont('helvetica','bold');pdf.text(`Balance: ${money(invoice.due)}`,145,y);pdf.save(`${invoice.number}.pdf`);
}
