import { Pool } from 'pg';
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : undefined });
