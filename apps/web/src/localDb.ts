import Dexie, { type Table } from 'dexie';
import { invoiceTotal, lineTotal, type InvoiceDraft, type Mutation, type SavedInvoice, uuid, validateInvoice } from '@dukaansetu/shared';

type Row = Record<string, any>;
class DukaanDatabase extends Dexie {
  parties!: Table<Row, string>; products!: Table<Row, string>; invoices!: Table<Row, string>;
  invoiceItems!: Table<Row, string>; mutations!: Table<Mutation & { queueId: string }, string>; metadata!: Table<{ key: string; value: string }, string>;
  constructor() {
    super('dukaan-setu');
    this.version(1).stores({parties:'id,phone,name',products:'id,name',invoices:'id,invoice_number,party_id,created_at',
      invoiceItems:'id,invoice_id',mutations:'queueId,entity_type,created_at',metadata:'key'});
  }
}
export const localDb = new DukaanDatabase();

export async function createInvoice(draft: InvoiceDraft, prefix: string): Promise<SavedInvoice> {
  const total = validateInvoice(draft), now = new Date().toISOString(), id = uuid(), due = Math.round((total - draft.paid) * 100) / 100;
  return localDb.transaction('rw', [localDb.parties, localDb.products, localDb.invoices, localDb.invoiceItems, localDb.mutations, localDb.metadata], async () => {
    const phone = draft.phone?.trim() || undefined;
    let party = phone ? await localDb.parties.where('phone').equals(phone).first() : await localDb.parties.where('name').equals(draft.partyName.trim()).first();
    if (!party) party = {id:uuid(),name:draft.partyName.trim(),phone,type:'CUSTOMER',credit_limit:0,current_balance:0,created_at:now,updated_at:now};
    party = {...party,name:draft.partyName.trim(),phone,current_balance:Number(party.current_balance || 0) + due,updated_at:now,sync_status:'PENDING'};
    await localDb.parties.put(party);
    const year = new Date().getFullYear().toString(), key = `invoice_sequence_${year}`;
    const seq = Number((await localDb.metadata.get(key))?.value || 0) + 1;
    await localDb.metadata.put({key,value:String(seq)});
    const number = `${prefix}-${year}-${String(seq).padStart(6,'0')}`;
    const invoice: Row = {id,invoice_number:number,party_id:party.id,total_amount:total,paid_amount:draft.paid,due_amount:due,
      payment_mode:draft.paymentMode,whatsapp_status:'QUEUED',due_date:due ? new Date(Date.now()+7*86400000).toISOString() : null,created_at:now,updated_at:now,sync_status:'PENDING'};
    const items = [];
    for (const line of draft.lines) {
      const productId=uuid(), itemId=uuid(), product={id:productId,name:line.name.trim(),unit:'PCS',wholesale_price:line.unitPrice,
        retail_price:line.unitPrice,purchase_price:line.unitPrice,stock_quantity:0,min_stock_alert:0,created_at:now,updated_at:now,sync_status:'PENDING'};
      const item={id:itemId,invoice_id:id,product_id:productId,quantity:line.quantity,unit_price:line.unitPrice,gst_rate:line.gstRate,total_price:lineTotal(line),created_at:now,updated_at:now};
      await localDb.products.put(product); await localDb.invoiceItems.put(item); items.push(item);
      await enqueue('product',productId,product,now);
    }
    await localDb.invoices.put(invoice);
    await enqueue('invoice',id,{...invoice,items},now);
    await enqueue('party',party.id,party,now);
    return {id,number,partyId:party.id,total,paid:draft.paid,due,createdAt:now};
  });
}

async function enqueue(type: Mutation['entity_type'], entityId: string, payload: Row, now: string) {
  await localDb.mutations.put({queueId:uuid(),id:uuid(),entity_type:type,entity_id:entityId,operation:'UPSERT',payload,created_at:now});
}

export async function pendingBillCount() { return localDb.mutations.where('entity_type').equals('invoice').count(); }

export async function syncOnce(baseUrl: string, token: string) {
  const queued = await localDb.mutations.orderBy('created_at').limit(100).toArray();
  const cursor = await localDb.metadata.get('last_synced_at');
  const res = await fetch(`${baseUrl.replace(/\/$/,'')}/api/v1/sync/push`, {method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},
    body:JSON.stringify({mutations:queued.map(({queueId,...m})=>({...m,payload:m.payload})),last_synced_at:cursor?.value})});
  if (!res.ok) throw new Error(`Sync returned ${res.status}`);
  const body = await res.json();
  await localDb.transaction('rw',[localDb.mutations,localDb.metadata,localDb.parties,localDb.products,localDb.invoices,localDb.invoiceItems],async()=>{
    await localDb.mutations.bulkDelete(queued.filter(m=>body.acknowledged_ids.includes(m.id)).map(m=>m.queueId));
    for (const d of body.deltas || []) {
      const p=d.payload;
      if(d.entity_type==='party') await localDb.parties.put({...p,sync_status:'SYNCED'});
      if(d.entity_type==='product') await localDb.products.put({...p,sync_status:'SYNCED'});
      // An invoice already saved locally is immutable; only import unseen cloud invoices.
      if(d.entity_type==='invoice' && !(await localDb.invoices.get(p.id))) {
        await localDb.invoices.put({...p,sync_status:'SYNCED'});
        if(p.items?.length) await localDb.invoiceItems.bulkPut(p.items.map((item:Row)=>({...item,sync_status:'SYNCED'})));
      }
    }
    await localDb.metadata.put({key:'last_synced_at',value:body.server_time});
  });
  if (queued.length === 100 && body.acknowledged_ids.length) void syncOnce(baseUrl,token);
}
