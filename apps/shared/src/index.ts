export type PaymentMode = 'CASH' | 'UPI' | 'UDHAAR';
export type SyncStatus = 'PENDING' | 'SYNCED' | 'FAILED';

export interface DraftLine {
  name: string;
  quantity: number;
  unitPrice: number;
  gstRate: number;
}

export interface InvoiceDraft {
  partyName: string;
  phone?: string;
  lines: DraftLine[];
  paid: number;
  paymentMode: PaymentMode;
}

export interface SavedInvoice {
  id: string;
  number: string;
  partyId: string;
  total: number;
  paid: number;
  due: number;
  createdAt: string;
}

export interface Mutation {
  id: string;
  entity_type: 'party' | 'product' | 'invoice';
  entity_id: string;
  operation: 'UPSERT';
  payload: Record<string, unknown>;
  created_at: string;
}

export const lineTotal = (line: DraftLine) =>
  Math.round(line.quantity * line.unitPrice * (1 + line.gstRate / 100) * 100) / 100;

export const invoiceTotal = (lines: DraftLine[]) =>
  Math.round(lines.reduce((sum, line) => sum + lineTotal(line), 0) * 100) / 100;

export function validateInvoice(draft: InvoiceDraft) {
  if (!draft.partyName.trim()) throw new Error('Enter customer name');
  if (!draft.lines.length || draft.lines.some(line => !line.name.trim() || line.quantity <= 0 || line.unitPrice < 0 || line.gstRate < 0)) {
    throw new Error('Add valid invoice items');
  }
  const total = invoiceTotal(draft.lines);
  if (draft.paid < 0 || draft.paid > total) throw new Error('Paid amount must be between zero and invoice total');
  return total;
}

export const uuid = () => uuidv4();
import { v4 as uuidv4 } from 'uuid';
