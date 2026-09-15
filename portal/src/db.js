// pg 连接池（运行时唯一依赖）。
import pg from 'pg';

const { Pool } = pg;

export function createPool(connectionString, options = {}) {
  const opts = {
    connectionString,
    max: options.max ?? 20,
  };
  if (options.ssl) opts.ssl = options.ssl;
  return new Pool(opts);
}
