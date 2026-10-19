import { Worker } from 'bullmq';
import { pool } from '../db/pool';
import { redis } from './queue';

// Replace this adapter with Meta Cloud API / an approved BSP. Template and consent
// requirements are provider/account specific; credentials stay server-side.
async function sendUtilityTemplate(payload: Record<string, unknown>) {
  if (process.env.WHATSAPP_PROVIDER === 'mock') {
    console.log('Mock WhatsApp utility template', JSON.stringify(payload));
    return;
  }
  throw new Error('Configure an approved WhatsApp Business provider adapter');
}

export const invoiceWorker = new Worker('whatsapp-invoices', async job => {
  const {tenantId, invoiceId} = job.data as {tenantId:string; invoiceId:string};
  const q = await pool.query(`SELECT i.invoice_number,i.total_amount,i.paid_amount,i.due_amount,i.share_token,p.name,p.phone
    FROM invoices i JOIN parties p ON p.tenant_id=i.tenant_id AND p.id=i.party_id
    WHERE i.tenant_id=$1 AND i.id=$2`,[tenantId,invoiceId]);
  if (!q.rowCount || !q.rows[0].phone) return;
  const row = q.rows[0];
  const upiLink = row.due_amount > 0 ? `upi://pay?pa=${encodeURIComponent(process.env.MERCHANT_UPI_ID ?? '')}&am=${row.due_amount}&cu=INR` : '';
  const pdfLink = `${process.env.PUBLIC_API_URL ?? ''}/public/invoices/${row.share_token}.pdf`;
  await sendUtilityTemplate({to:row.phone,customer:row.name,invoice:row.invoice_number,
    total:row.total_amount,paid:row.paid_amount,balance:row.due_amount,
    pdfUrl:pdfLink,upiLink});
  await pool.query(`UPDATE invoices SET whatsapp_status='SENT',updated_at=now() WHERE tenant_id=$1 AND id=$2`,[tenantId,invoiceId]);
  await pool.query('DELETE FROM whatsapp_outbox WHERE tenant_id=$1 AND invoice_id=$2',[tenantId,invoiceId]);
}, {connection:redis, concurrency:10});

export const reminderWorker = new Worker('ledger-reminders', async job => {
  const {tenantId, partyId} = job.data as {tenantId:string; partyId:string};
  const sql = `SELECT p.id,p.name,p.phone,
    COALESCE((SELECT sum(GREATEST(i.due_amount-COALESCE((SELECT sum(l.amount) FROM ledger_transactions l
      WHERE l.tenant_id=i.tenant_id AND l.reference_invoice_id=i.id AND l.payment_type='PAYMENT_IN'),0),0))
      FROM invoices i WHERE i.tenant_id=p.tenant_id AND i.party_id=p.id AND i.due_amount>0 AND i.due_date<=current_date),0) AS balance
    FROM parties p WHERE p.tenant_id=$1 AND ($2::uuid IS NULL OR p.id=$2) AND p.type='CUSTOMER'`;
  const q = await pool.query(sql,[tenantId,partyId ?? null]);
  for (const party of q.rows) {
    if (party.phone && Number(party.balance)>0) await sendUtilityTemplate({to:party.phone,customer:party.name,balance:party.balance,
      upiLink:`upi://pay?pa=${encodeURIComponent(process.env.MERCHANT_UPI_ID ?? '')}&am=${party.balance}&cu=INR`});
  }
}, {connection:redis, concurrency:5});
