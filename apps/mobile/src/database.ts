import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import { lineTotal, type InvoiceDraft, type Mutation, type SavedInvoice, uuid, validateInvoice } from '@dukaansetu/shared';

let opened: Promise<SQLite.SQLiteDatabase> | undefined;
export async function database() {
  if (!opened) opened=(async()=>{
    let key=await SecureStore.getItemAsync('sqlcipher_key');
    if(!key){key=uuid();await SecureStore.setItemAsync('sqlcipher_key',key);}
    const db=await SQLite.openDatabaseAsync('dukaan-setu.db');
    await db.execAsync(`PRAGMA key = '${key.replaceAll("'","''")}'; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS parties(id TEXT PRIMARY KEY,name TEXT NOT NULL,phone TEXT,type TEXT NOT NULL,credit_limit REAL DEFAULT 0,current_balance REAL DEFAULT 0,created_at TEXT,updated_at TEXT,sync_status TEXT DEFAULT 'PENDING');
      CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,name TEXT NOT NULL,unit TEXT,wholesale_price REAL,retail_price REAL,purchase_price REAL,stock_quantity REAL DEFAULT 0,min_stock_alert REAL DEFAULT 0,created_at TEXT,updated_at TEXT,sync_status TEXT DEFAULT 'PENDING');
      CREATE TABLE IF NOT EXISTS invoices(id TEXT PRIMARY KEY,invoice_number TEXT UNIQUE,party_id TEXT,total_amount REAL,paid_amount REAL,due_amount REAL,payment_mode TEXT,whatsapp_status TEXT,due_date TEXT,created_at TEXT,updated_at TEXT,sync_status TEXT DEFAULT 'PENDING');
      CREATE TABLE IF NOT EXISTS invoice_items(id TEXT PRIMARY KEY,invoice_id TEXT,product_id TEXT,quantity REAL,unit_price REAL,gst_rate REAL,total_price REAL,created_at TEXT,updated_at TEXT,sync_status TEXT DEFAULT 'PENDING');
      CREATE TABLE IF NOT EXISTS ledger_transactions(id TEXT PRIMARY KEY,party_id TEXT,amount REAL,payment_type TEXT,reference_invoice_id TEXT,notes TEXT,created_at TEXT,updated_at TEXT,sync_status TEXT DEFAULT 'PENDING');
      CREATE TABLE IF NOT EXISTS stock_movements(id TEXT PRIMARY KEY,product_id TEXT,stock_delta REAL,reference_invoice_id TEXT,created_at TEXT,updated_at TEXT,sync_status TEXT DEFAULT 'PENDING');
      CREATE TABLE IF NOT EXISTS outbound_sync_queue(id TEXT PRIMARY KEY,entity_type TEXT,entity_id TEXT,operation TEXT,payload TEXT,created_at TEXT,attempts INTEGER DEFAULT 0,last_error TEXT);
      CREATE TABLE IF NOT EXISTS local_metadata(key TEXT PRIMARY KEY,value TEXT);`);
    return db;
  })();
  return opened;
}

async function enqueue(db:SQLite.SQLiteDatabase,type:Mutation['entity_type'],entityId:string,payload:object,now:string){
  await db.runAsync('INSERT INTO outbound_sync_queue(id,entity_type,entity_id,operation,payload,created_at) VALUES(?,?,?,?,?,?)',uuid(),type,entityId,'UPSERT',JSON.stringify(payload),now);
}

export async function saveInvoice(draft:InvoiceDraft,prefix:string):Promise<SavedInvoice>{
  const total=validateInvoice(draft),now=new Date().toISOString(),invoiceId=uuid(),due=Math.round((total-draft.paid)*100)/100,db=await database();
  let saved!:SavedInvoice;
  await db.withTransactionAsync(async()=>{
    const phone=draft.phone?.trim()||null;
    const party=phone?await db.getFirstAsync<any>('SELECT * FROM parties WHERE phone=? LIMIT 1',phone):await db.getFirstAsync<any>('SELECT * FROM parties WHERE name=? LIMIT 1',draft.partyName.trim());
    const partyId=party?.id||uuid(),balance=Number(party?.current_balance||0)+due;
    await db.runAsync(`INSERT INTO parties(id,name,phone,type,credit_limit,current_balance,created_at,updated_at,sync_status) VALUES(?,?,?,'CUSTOMER',?,?,?,?,'PENDING')
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,phone=excluded.phone,current_balance=excluded.current_balance,updated_at=excluded.updated_at,sync_status='PENDING'`,partyId,draft.partyName.trim(),phone,party?.credit_limit||0,balance,party?.created_at||now,now);
    const year=String(new Date().getFullYear()),meta=await db.getFirstAsync<any>('SELECT value FROM local_metadata WHERE key=?',`invoice_sequence_${year}`),seq=Number(meta?.value||0)+1;
    await db.runAsync('INSERT OR REPLACE INTO local_metadata(key,value) VALUES(?,?)',`invoice_sequence_${year}`,String(seq));
    const number=`${prefix}-${year}-${String(seq).padStart(6,'0')}`,invoice={id:invoiceId,invoice_number:number,party_id:partyId,total_amount:total,paid_amount:draft.paid,due_amount:due,payment_mode:draft.paymentMode,
      whatsapp_status:'QUEUED',due_date:due?new Date(Date.now()+7*86400000).toISOString():null,created_at:now,updated_at:now};
    const items=[];
    for(const line of draft.lines){
      const productId=uuid(),item={id:uuid(),invoice_id:invoiceId,product_id:productId,quantity:line.quantity,unit_price:line.unitPrice,gst_rate:line.gstRate,total_price:lineTotal(line),created_at:now,updated_at:now};
      const product={id:productId,name:line.name.trim(),unit:'PCS',wholesale_price:line.unitPrice,retail_price:line.unitPrice,purchase_price:line.unitPrice,min_stock_alert:0,created_at:now,updated_at:now};
      await db.runAsync('INSERT INTO products(id,name,unit,wholesale_price,retail_price,purchase_price,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',productId,product.name,product.unit,product.wholesale_price,product.retail_price,product.purchase_price,now,now);
      await db.runAsync('INSERT INTO invoice_items(id,invoice_id,product_id,quantity,unit_price,gst_rate,total_price,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',item.id,item.invoice_id,item.product_id,item.quantity,item.unit_price,item.gst_rate,item.total_price,now,now);
      await enqueue(db,'product',productId,product,now);items.push(item);
    }
    await db.runAsync('INSERT INTO invoices(id,invoice_number,party_id,total_amount,paid_amount,due_amount,payment_mode,whatsapp_status,due_date,created_at,updated_at) VALUES(?,?,?,?,?,?,? ,\'QUEUED\',?,?,?)',invoiceId,number,partyId,total,draft.paid,due,draft.paymentMode,invoice.due_date,now,now);
    await enqueue(db,'invoice',invoiceId,{...invoice,items},now);
    await enqueue(db,'party',partyId,{id:partyId,name:draft.partyName.trim(),phone,type:'CUSTOMER',credit_limit:party?.credit_limit||0,current_balance:balance,created_at:party?.created_at||now,updated_at:now},now);
    saved={id:invoiceId,number,partyId,total,paid:draft.paid,due,createdAt:now};
  });
  return saved;
}

export async function queuedBills(){const db=await database();return (await db.getFirstAsync<any>("SELECT count(*) as n FROM outbound_sync_queue WHERE entity_type='invoice'"))?.n||0;}
export async function pushSync(baseUrl:string,token:string){
  const db=await database(),queue=await db.getAllAsync<any>('SELECT * FROM outbound_sync_queue ORDER BY created_at LIMIT 100'),cursor=await db.getFirstAsync<any>("SELECT value FROM local_metadata WHERE key='last_synced_at'");
  const response=await fetch(`${baseUrl.replace(/\/$/,'')}/api/v1/sync/push`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},
    body:JSON.stringify({mutations:queue.map(m=>({id:m.id,entity_type:m.entity_type,entity_id:m.entity_id,operation:m.operation,payload:JSON.parse(m.payload),created_at:m.created_at})),last_synced_at:cursor?.value})});
  if(!response.ok)throw new Error(`Sync returned ${response.status}`);const result=await response.json();
  await db.withTransactionAsync(async()=>{for(const id of result.acknowledged_ids)await db.runAsync('DELETE FROM outbound_sync_queue WHERE id=?',id);
    for(const d of result.deltas||[]){const p=d.payload;
      if(d.entity_type==='party')await db.runAsync(`INSERT OR IGNORE INTO parties(id,name,phone,type,credit_limit,current_balance,created_at,updated_at,sync_status) VALUES(?,?,?,?,?,?,?,?, 'SYNCED')`,p.id,p.name,p.phone,p.type,p.credit_limit,p.current_balance,p.created_at,p.updated_at);
      if(d.entity_type==='product')await db.runAsync(`INSERT OR IGNORE INTO products(id,name,unit,wholesale_price,retail_price,purchase_price,stock_quantity,min_stock_alert,created_at,updated_at,sync_status) VALUES(?,?,?,?,?,?,?,?,?,?, 'SYNCED')`,p.id,p.name,p.unit,p.wholesale_price,p.retail_price,p.purchase_price,p.stock_quantity,p.min_stock_alert,p.created_at,p.updated_at);
      if(d.entity_type==='invoice'){
        const existing=await db.getFirstAsync<any>('SELECT id FROM invoices WHERE id=?',p.id);
        if(!existing){await db.runAsync(`INSERT OR IGNORE INTO invoices(id,invoice_number,party_id,total_amount,paid_amount,due_amount,payment_mode,whatsapp_status,due_date,created_at,updated_at,sync_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,'SYNCED')`,p.id,p.invoice_number,p.party_id,p.total_amount,p.paid_amount,p.due_amount,p.payment_mode,p.whatsapp_status,p.due_date,p.created_at,p.updated_at);
          for(const item of p.items||[])await db.runAsync(`INSERT OR IGNORE INTO invoice_items(id,invoice_id,product_id,quantity,unit_price,gst_rate,total_price,created_at,updated_at,sync_status) VALUES(?,?,?,?,?,?,?,?,?,'SYNCED')`,item.id,item.invoice_id,item.product_id,item.quantity,item.unit_price,item.gst_rate,item.total_price,item.created_at,item.updated_at);}
      }
      if(d.entity_type==='ledger_transaction')await db.runAsync(`INSERT OR IGNORE INTO ledger_transactions(id,party_id,amount,payment_type,reference_invoice_id,notes,created_at,updated_at,sync_status) VALUES(?,?,?,?,?,?,?,?,'SYNCED')`,p.id,p.party_id,p.amount,p.payment_type,p.reference_invoice_id,p.notes,p.created_at,p.updated_at);
      if(d.entity_type==='stock_movement')await db.runAsync(`INSERT OR IGNORE INTO stock_movements(id,product_id,stock_delta,reference_invoice_id,created_at,updated_at,sync_status) VALUES(?,?,?,?,?,?,'SYNCED')`,p.id,p.product_id,p.stock_delta,p.reference_invoice_id,p.created_at,p.created_at);
    }
    await db.runAsync('INSERT OR REPLACE INTO local_metadata(key,value) VALUES(?,?)','last_synced_at',result.server_time);});
  if(queue.length===100&&result.acknowledged_ids.length)void pushSync(baseUrl,token);
}
