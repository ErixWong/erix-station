// outbox 写入助手：在 DB 事务里写 desired state + outbox 行 + 递增 revision head。
// 依据：docs/design/user-space.md §7.1（materialize_outbox/revisions）、
//       docs/design/topology.md §8 / docs/data/schema.sql §9（route_outbox/revisions）。

/**
 * 递增 route_revisions head，返回新 revision（单调递增）。
 * 必须在事务内以同一 client 调用（与 outbox 行同事务）。
 */
export async function bumpRouteRevision(client, aggregate, aggregateId) {
  const r = await client.query(
    `INSERT INTO route_revisions (aggregate, aggregate_id, revision, updated_at)
     VALUES ($1, $2, 1, now())
     ON CONFLICT (aggregate, aggregate_id)
     DO UPDATE SET revision = route_revisions.revision + 1, updated_at = now()
     RETURNING revision`,
    [aggregate, aggregateId],
  );
  return Number(r.rows[0].revision);
}

/**
 * 写一条 route_outbox 行（revision = head，由调用方先 bumpRouteRevision 得到）。
 */
export async function enqueueRouteOp(client, { aggregate, aggregateId, op, revision, payload = {} }) {
  await client.query(
    `INSERT INTO route_outbox (aggregate, aggregate_id, op, revision, payload, state)
     VALUES ($1, $2, $3, $4, $5, 'pending')`,
    [aggregate, aggregateId, op, revision, JSON.stringify(payload)],
  );
}

/**
 * 组合：bump route revision head + 写 outbox 行，返回 revision。
 */
export async function enqueueRouteChange(client, { aggregate, aggregateId, op, payload = {} }) {
  const revision = await bumpRouteRevision(client, aggregate, aggregateId);
  await enqueueRouteOp(client, { aggregate, aggregateId, op, revision, payload });
  return revision;
}

/** 递增 materialize_revisions head（每 FDE 一行），返回新 revision。 */
export async function bumpMaterializeRevision(client, fdeId) {
  const r = await client.query(
    `INSERT INTO materialize_revisions (fde_id, revision, updated_at)
     VALUES ($1, 1, now())
     ON CONFLICT (fde_id)
     DO UPDATE SET revision = materialize_revisions.revision + 1, updated_at = now()
     RETURNING revision`,
    [fdeId],
  );
  return Number(r.rows[0].revision);
}

/** 写一条 materialize_outbox 行。 */
export async function enqueueMaterializeOp(client, { fdeId, op, revision, payload = {} }) {
  await client.query(
    `INSERT INTO materialize_outbox (fde_id, op, revision, payload, state)
     VALUES ($1, $2, $3, $4, 'pending')`,
    [fdeId, op, revision, JSON.stringify(payload)],
  );
}

/** 组合：bump materialize revision head + 写 outbox 行，返回 revision。 */
export async function enqueueMaterializeChange(client, { fdeId, op, payload = {} }) {
  const revision = await bumpMaterializeRevision(client, fdeId);
  await enqueueMaterializeOp(client, { fdeId, op, revision, payload });
  return revision;
}
