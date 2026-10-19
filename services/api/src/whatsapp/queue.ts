import { Queue } from 'bullmq';
import IORedis from 'ioredis';
export const redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {maxRetriesPerRequest: null});
export const invoiceQueue = new Queue('whatsapp-invoices', {connection: redis});
export const reminderQueue = new Queue('ledger-reminders', {connection: redis});
