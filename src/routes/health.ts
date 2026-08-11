import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AppContext } from '../context.js';

export async function handleHealth(_req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  return reply.code(200).send({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
}

export async function handleMetrics(ctx: AppContext, reply: FastifyReply): Promise<FastifyReply> {
  return reply
    .code(200)
    .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
    .send(ctx.metrics.render());
}
