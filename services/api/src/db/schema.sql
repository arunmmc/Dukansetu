CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS parties (
  tenant_id uuid NOT NULL, id uuid NOT NULL, name text NOT NULL, phone text, gstin text,
  type text NOT NULL CHECK (type IN ('CUSTOMER','SUPPLIER')), credit_limit numeric(14,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz,
  PRIMARY KEY (tenant_id,id)
);
CREATE TABLE IF NOT EXISTS products (
  tenant_id uuid NOT NULL, id uuid NOT NULL, name text NOT NULL, hsn_code text, unit text NOT NULL,
  wholesale_price numeric(14,2) NOT NULL, retail_price numeric(14,2) NOT NULL, purchase_price numeric(14,2) NOT NULL,
  min_stock_alert numeric(14,3) NOT NULL DEFAULT 0, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  deleted_at timestamptz, PRIMARY KEY (tenant_id,id)
);
CREATE TABLE IF NOT EXISTS invoices (
  tenant_id uuid NOT NULL, id uuid NOT NULL, invoice_number text NOT NULL, party_id uuid NOT NULL,
  total_amount numeric(14,2) NOT NULL, paid_amount numeric(14,2) NOT NULL, due_amount numeric(14,2) NOT NULL,
  payment_mode text NOT NULL, whatsapp_status text NOT NULL DEFAULT 'QUEUED', due_date date, created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL, deleted_at timestamptz, share_token uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,invoice_number),
  FOREIGN KEY (tenant_id,party_id) REFERENCES parties(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS invoice_items (
  tenant_id uuid NOT NULL, id uuid NOT NULL, invoice_id uuid NOT NULL, product_id uuid NOT NULL,
  quantity numeric(14,3) NOT NULL, unit_price numeric(14,2) NOT NULL, gst_rate numeric(7,3) NOT NULL,
  total_price numeric(14,2) NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id), FOREIGN KEY (tenant_id,invoice_id) REFERENCES invoices(tenant_id,id),
  FOREIGN KEY (tenant_id,product_id) REFERENCES products(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS ledger_transactions (
  tenant_id uuid NOT NULL, id uuid NOT NULL, party_id uuid NOT NULL, amount numeric(14,2) NOT NULL,
  payment_type text NOT NULL CHECK (payment_type IN ('PAYMENT_IN','PAYMENT_OUT','OPENING_BALANCE')),
  reference_invoice_id uuid, notes text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id), FOREIGN KEY (tenant_id,party_id) REFERENCES parties(tenant_id,id),
  FOREIGN KEY (tenant_id,reference_invoice_id) REFERENCES invoices(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS stock_movements (
  tenant_id uuid NOT NULL, id uuid NOT NULL, product_id uuid NOT NULL, stock_delta numeric(14,3) NOT NULL,
  reference_invoice_id uuid, created_at timestamptz NOT NULL, synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), FOREIGN KEY (tenant_id,product_id) REFERENCES products(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS sync_mutations (
  tenant_id uuid NOT NULL, id uuid NOT NULL, entity_type text NOT NULL, entity_id uuid NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id)
);
CREATE TABLE IF NOT EXISTS whatsapp_outbox (
  tenant_id uuid NOT NULL, invoice_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,invoice_id), FOREIGN KEY (tenant_id,invoice_id) REFERENCES invoices(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS invoices_party_created_idx ON invoices(tenant_id,party_id,created_at DESC);
CREATE INDEX IF NOT EXISTS ledger_party_created_idx ON ledger_transactions(tenant_id,party_id,created_at DESC);
CREATE INDEX IF NOT EXISTS stock_product_created_idx ON stock_movements(tenant_id,product_id,created_at DESC);
CREATE INDEX IF NOT EXISTS stock_sync_cursor_idx ON stock_movements(tenant_id,synced_at);
