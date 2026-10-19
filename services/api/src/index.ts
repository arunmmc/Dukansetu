import 'dotenv/config';
import express from 'express';
import PDFDocument from 'pdfkit';
import { pool } from './db/pool';
import { applyMutations, getDeltas, PushBody } from './sync/processor';
import { invoiceQueue, reminderQueue } from './whatsapp/queue';
import './whatsapp/worker';

const app = express();
const allowedOrigins = new Set((process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',').map(origin => origin.trim()).filter(Boolean));
app.use((req,res,next) => {
  const origin = req.header('origin');
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  next();
});
app.use(express.json({limit:'2mb'}));
const port = Number(process.env.PORT ?? 3000);

// Possession of this unguessable token grants read-only access to one invoice PDF.
app.get('/public/invoices/:token.pdf', async (req,res) => {
  try {
    const result = await pool.query(`SELECT i.invoice_number,i.total_amount,i.paid_amount,i.due_amount,i.created_at,p.name AS party_name
      FROM invoices i JOIN parties p ON p.tenant_id=i.tenant_id AND p.id=i.party_id WHERE i.share_token=$1`,[req.params.token]);
    if (!result.rowCount) { res.status(404).end(); return; }
    const invoice = result.rows[0];
    const lines = await pool.query(`SELECT ii.quantity,ii.unit_price,ii.gst_rate,ii.total_price,pr.name
      FROM invoice_items ii JOIN products pr ON pr.tenant_id=ii.tenant_id AND pr.id=ii.product_id
      JOIN invoices i ON i.tenant_id=ii.tenant_id AND i.id=ii.invoice_id WHERE i.share_token=$1 ORDER BY ii.created_at`,[req.params.token]);
    res.setHeader('content-type','application/pdf');
    res.setHeader('content-disposition',`inline; filename="${invoice.invoice_number}.pdf"`);
    const doc = new PDFDocument({margin:48});
    doc.pipe(res);
    doc.fontSize(22).text('Invoice'); doc.moveDown();
    doc.fontSize(12).text(`Invoice: ${invoice.invoice_number}`);
    doc.text(`Customer: ${invoice.party_name}`);
    doc.text(`Date: ${new Date(invoice.created_at).toLocaleDateString('en-IN')}`); doc.moveDown();
    doc.font('Helvetica-Bold').text('Item                         Qty       Rate           Amount');
    doc.font('Helvetica');
    for (const line of lines.rows) doc.text(`${line.name}    ${line.quantity}    ₹${line.unit_price}    ₹${line.total_price}`);
    doc.moveDown().font('Helvetica-Bold').text(`Total: ₹${invoice.total_amount}`,{align:'right'});
    doc.font('Helvetica').text(`Paid: ₹${invoice.paid_amount}`,{align:'right'});
    doc.font('Helvetica-Bold').text(`Balance: ₹${invoice.due_amount}`,{align:'right'});
    doc.end();
  } catch (error) { console.error('invoice pdf failed',error); if (!res.headersSent) res.status(500).end(); }
});

// Demo auth only: in production a verified identity gateway must set tenant_id/device_id.
app.use('/api/v1', (req,res,next) => {
  if (!process.env.SYNC_TOKEN || req.header('authorization') !== `Bearer ${process.env.SYNC_TOKEN}`) {
    res.status(401).json({error:'unauthorized'}); return;
  }
  next();
});
app.get('/health', async (_req,res) => {
  try { await pool.query('SELECT 1'); res.json({ok:true}); }
  catch { res.status(503).json({ok:false}); }
});
app.post('/api/v1/sync/push', async (req,res) => {
  const parsed = PushBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({error:'invalid_payload',details:parsed.error.flatten()}); return; }
  const tenantId = process.env.TENANT_ID;
  if (!tenantId) { res.status(500).json({error:'tenant_context_missing'}); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await applyMutations(client,tenantId,parsed.data.mutations);
    const deltas = await getDeltas(client,tenantId,parsed.data.last_synced_at);
    await client.query('COMMIT');
    for (const invoiceId of result.whatsapp) await invoiceQueue.add('send-invoice',{tenantId,invoiceId},
      {jobId:`${tenantId}:${invoiceId}`,attempts:8,backoff:{type:'exponential',delay:3000},removeOnComplete:1000});
    res.json({acknowledged_ids:result.acknowledged,deltas,server_time:new Date().toISOString()});
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('sync push failed',error);
    res.status(500).json({error:'sync_failed'});
  } finally { client.release(); }
});

// Schedule daily ledger checks. Production should select eligible overdue invoices
// and enqueue once per tenant/customer/day with consent and reminder policy checks.
void reminderQueue.upsertJobScheduler('daily-ledger-reminders', {pattern:'0 9 * * *'},
  {name:'scan-overdue-ledgers',data:{tenantId:process.env.TENANT_ID},opts:{removeOnComplete:20}});
app.listen(port,() => console.log(`DukaanSetu API listening on ${port}`));
