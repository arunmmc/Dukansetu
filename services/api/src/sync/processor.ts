import { PoolClient } from 'pg';
import { z } from 'zod';
import { invoiceQueue } from '../whatsapp/queue';

const Mutation = z.object({id:z.string().uuid(),entity_type:z.enum(['party','product','invoice','ledger_transaction','stock_movement']),
  entity_id:z.string().uuid(),operation:z.literal('UPSERT'),payload:z.record(z.unknown()),created_at:z.string()});
export const PushBody = z.object({mutations:z.array(Mutation).max(500),last_synced_at:z.string().optional()});
const date = (v: unknown) => new Date(String(v));
const num = (v: unknown) => Number(v ?? 0);

export async function applyMutations(client: PoolClient, tenantId: string, raw: unknown[]) {
  const mutations = z.array(Mutation).max(500).parse(raw);
  // Parents first so a single offline batch can create party/product and invoice atomically.
  const priority: Record<string,number> = {party:0,product:1,invoice:2,ledger_transaction:3,stock_movement:3};
  mutations.sort((a,b) => priority[a.entity_type]-priority[b.entity_type]);
  const acknowledged: string[] = [];
  const whatsapp: string[] = [];
  for (const m of mutations) {
    const claim = await client.query('INSERT INTO sync_mutations(tenant_id,id,entity_type,entity_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',
      [tenantId,m.id,m.entity_type,m.entity_id]);
    if (!claim.rowCount) { acknowledged.push(m.id); continue; }
    const p = m.payload;
    switch (m.entity_type) {
      case 'party': await client.query(`INSERT INTO parties(tenant_id,id,name,phone,gstin,type,credit_limit,created_at,updated_at,deleted_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,now(),$9) ON CONFLICT(tenant_id,id) DO UPDATE SET name=EXCLUDED.name,phone=EXCLUDED.phone,gstin=EXCLUDED.gstin,
        type=EXCLUDED.type,credit_limit=EXCLUDED.credit_limit,updated_at=now(),deleted_at=EXCLUDED.deleted_at
        WHERE parties.updated_at < now()`,[tenantId,p.id,p.name,p.phone??null,p.gstin??null,p.type,num(p.credit_limit),date(p.created_at),p.deleted_at?date(p.deleted_at):null]); break;
      case 'product': await client.query(`INSERT INTO products(tenant_id,id,name,hsn_code,unit,wholesale_price,retail_price,purchase_price,min_stock_alert,created_at,updated_at,deleted_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11) ON CONFLICT(tenant_id,id) DO UPDATE SET name=EXCLUDED.name,updated_at=now()
        WHERE products.updated_at < now()`,[tenantId,p.id,p.name,p.hsn_code??null,p.unit,num(p.wholesale_price),num(p.retail_price),num(p.purchase_price),num(p.min_stock_alert),date(p.created_at),p.deleted_at?date(p.deleted_at):null]); break;
      case 'invoice': {
        const exists = await client.query('SELECT 1 FROM invoices WHERE tenant_id=$1 AND id=$2',[tenantId,p.id]);
        if (!exists.rowCount) {
          await client.query(`INSERT INTO invoices(tenant_id,id,invoice_number,party_id,total_amount,paid_amount,due_amount,payment_mode,whatsapp_status,due_date,created_at,updated_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,'QUEUED',$9,$10,now())`,[tenantId,p.id,p.invoice_number,p.party_id,num(p.total_amount),num(p.paid_amount),num(p.due_amount),p.payment_mode,p.due_date?date(p.due_date):null,date(p.created_at)]);
          for (const rawItem of (p.items as Record<string,unknown>[] ?? [])) await client.query(`INSERT INTO invoice_items(tenant_id,id,invoice_id,product_id,quantity,unit_price,gst_rate,total_price,created_at,updated_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,[tenantId,rawItem.id,p.id,rawItem.product_id,num(rawItem.quantity),num(rawItem.unit_price),num(rawItem.gst_rate),num(rawItem.total_price),date(rawItem.created_at),date(rawItem.updated_at)]);
          await client.query('INSERT INTO whatsapp_outbox(tenant_id,invoice_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[tenantId,p.id]);
          whatsapp.push(String(p.id));
        }
        break;
      }
      case 'ledger_transaction': await client.query(`INSERT INTO ledger_transactions(tenant_id,id,party_id,amount,payment_type,reference_invoice_id,notes,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()) ON CONFLICT DO NOTHING`,[tenantId,p.id,p.party_id,num(p.amount),p.payment_type,p.reference_invoice_id??null,p.notes??null,date(p.created_at)]); break;
      case 'stock_movement': await client.query(`INSERT INTO stock_movements(tenant_id,id,product_id,stock_delta,reference_invoice_id,created_at,synced_at)
        VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT DO NOTHING`,[tenantId,p.id,p.product_id,num(p.stock_delta),p.reference_invoice_id??null,date(p.created_at)]); break;
    }
    acknowledged.push(m.id);
  }
  return {acknowledged, whatsapp};
}

export async function getDeltas(client: PoolClient, tenantId: string, since?: string) {
  const cursor = since ? date(since) : new Date(0);
  const [parties,products,invoices,ledger,stock] = await Promise.all([
    client.query(`SELECT 'party' entity_type,p.id entity_id,jsonb_build_object('id',p.id,'name',p.name,'phone',p.phone,'gstin',p.gstin,'type',p.type,'credit_limit',p.credit_limit,
      'current_balance',COALESCE((SELECT sum(i.due_amount) FROM invoices i WHERE i.tenant_id=p.tenant_id AND i.party_id=p.id),0)
      + COALESCE((SELECT sum(CASE WHEN l.payment_type='PAYMENT_OUT' OR l.payment_type='OPENING_BALANCE' THEN l.amount ELSE -l.amount END) FROM ledger_transactions l WHERE l.tenant_id=p.tenant_id AND l.party_id=p.id),0),
      'created_at',p.created_at,'updated_at',p.updated_at,'deleted_at',p.deleted_at) payload,
      GREATEST(p.updated_at,COALESCE((SELECT max(i.updated_at) FROM invoices i WHERE i.tenant_id=p.tenant_id AND i.party_id=p.id),p.updated_at),
      COALESCE((SELECT max(l.updated_at) FROM ledger_transactions l WHERE l.tenant_id=p.tenant_id AND l.party_id=p.id),p.updated_at)) changed_at
      FROM parties p WHERE p.tenant_id=$1 AND (p.updated_at>$2 OR EXISTS(SELECT 1 FROM invoices i WHERE i.tenant_id=p.tenant_id AND i.party_id=p.id AND i.updated_at>$2)
      OR EXISTS(SELECT 1 FROM ledger_transactions l WHERE l.tenant_id=p.tenant_id AND l.party_id=p.id AND l.updated_at>$2)) ORDER BY changed_at LIMIT 1000`,[tenantId,cursor]),
    client.query(`SELECT 'product' entity_type,id entity_id,jsonb_build_object('id',id,'name',name,'hsn_code',hsn_code,'unit',unit,'wholesale_price',wholesale_price,
      'retail_price',retail_price,'purchase_price',purchase_price,'stock_quantity',COALESCE((SELECT sum(stock_delta) FROM stock_movements s WHERE s.tenant_id=products.tenant_id AND s.product_id=products.id),0),
      'min_stock_alert',min_stock_alert,'created_at',created_at,'updated_at',updated_at,'deleted_at',deleted_at) payload,
      GREATEST(updated_at,COALESCE((SELECT max(s.synced_at) FROM stock_movements s WHERE s.tenant_id=products.tenant_id AND s.product_id=products.id),updated_at)) changed_at
      FROM products WHERE tenant_id=$1 AND (updated_at>$2 OR EXISTS(SELECT 1 FROM stock_movements s WHERE s.tenant_id=products.tenant_id AND s.product_id=products.id AND s.synced_at>$2)) ORDER BY changed_at LIMIT 1000`,[tenantId,cursor]),
    client.query(`SELECT 'invoice' entity_type,i.id entity_id,jsonb_build_object('id',i.id,'invoice_number',i.invoice_number,'party_id',i.party_id,'total_amount',i.total_amount,
      'paid_amount',i.paid_amount,'due_amount',i.due_amount,'payment_mode',i.payment_mode,'whatsapp_status',i.whatsapp_status,'due_date',i.due_date,'created_at',i.created_at,'updated_at',i.updated_at,
      'items',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',ii.id,'invoice_id',ii.invoice_id,'product_id',ii.product_id,'quantity',ii.quantity,'unit_price',ii.unit_price,
        'gst_rate',ii.gst_rate,'total_price',ii.total_price,'created_at',ii.created_at,'updated_at',ii.updated_at)) FROM invoice_items ii WHERE ii.tenant_id=i.tenant_id AND ii.invoice_id=i.id),'[]'::jsonb)) payload,i.updated_at changed_at
      FROM invoices i WHERE i.tenant_id=$1 AND i.updated_at>$2 ORDER BY i.updated_at LIMIT 1000`,[tenantId,cursor]),
    client.query(`SELECT 'ledger_transaction' entity_type,id entity_id,jsonb_build_object('id',id,'party_id',party_id,'amount',amount,'payment_type',payment_type,
      'reference_invoice_id',reference_invoice_id,'notes',notes,'created_at',created_at,'updated_at',updated_at) payload,updated_at changed_at FROM ledger_transactions WHERE tenant_id=$1 AND updated_at>$2 ORDER BY updated_at LIMIT 1000`,[tenantId,cursor]),
    client.query(`SELECT 'stock_movement' entity_type,id entity_id,jsonb_build_object('id',id,'product_id',product_id,'stock_delta',stock_delta,
      'reference_invoice_id',reference_invoice_id,'created_at',created_at) payload,synced_at changed_at FROM stock_movements WHERE tenant_id=$1 AND synced_at>$2 ORDER BY synced_at LIMIT 1000`,[tenantId,cursor]),
  ]);
  return [...parties.rows,...products.rows,...invoices.rows,...ledger.rows,...stock.rows]
    .sort((a,b) => new Date(a.changed_at).getTime()-new Date(b.changed_at).getTime())
    .map(({entity_type,entity_id,payload}) => ({entity_type,entity_id,payload}));
}
